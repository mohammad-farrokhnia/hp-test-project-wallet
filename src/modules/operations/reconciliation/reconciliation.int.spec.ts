import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { APP_OPTIONS, configureBodyParsing } from '../../../common/http';
import { connectTestDb, describeDb } from '../../../database/int-testing';
import { TransactionRunner } from '../../../database/transaction-runner';
import { DepositSyncHandler } from '../../deposit/handlers/deposit-sync.handler';
import { DepositLifecycleRepository } from '../../deposit/repositories/deposit-lifecycle.repository';
import { HttpPspClient } from '../../integrations/psp/http-psp.client';
import {
  DEPOSIT_TYPE,
  SETTLEMENT_HEADER,
} from '../../integrations/psp/settlement-csv';
import { FakePspServer } from '../../integrations/psp/testing/fake-psp-server';
import {
  settlementFile,
  withLines,
} from '../../integrations/psp/testing/settlement-file';
import { newLedgerService } from '../../ledger/testing';
import type { RunView } from './reconciliation.controller';

interface Credited {
  id: string;
  userId: string;
  reference: string;
  amountRial: bigint;
}

describeDb('settlement reconciliation (real PostgreSQL, fake PSP)', () => {
  let ds: DataSource;
  let app: NestExpressApplication;
  let handler: DepositSyncHandler;
  const psp = new FakePspServer();
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    ds = await connectTestDb();
    const pspUrl = await psp.start();
    Object.assign(process.env, {
      PSP_BASE_URL: pspUrl,
      HTTP_TIMEOUT_MS: '1000',
      DEPOSIT_CREATE_LEASE_SECONDS: '2',
    });
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRole('api')],
    }).compile();
    app = ref.createNestApplication<NestExpressApplication>(APP_OPTIONS);
    configureBodyParsing(app);
    await app.listen(0, '127.0.0.1');
    handler = new DepositSyncHandler(
      new TransactionRunner(ds, {
        lockTimeoutMs: 10_000,
        statementTimeoutMs: 20_000,
      }),
      new DepositLifecycleRepository(),
      newLedgerService(),
      new HttpPspClient(pspUrl, 1000),
    );
  });

  afterAll(async () => {
    await app?.close();
    await psp.stop();
    if (ds?.isInitialized) await ds.destroy();
    process.env = savedEnv;
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    psp.settlementFault = 'ok';
  });

  /** A day long past, chosen at random: our deposits are moved onto it, so a run sees these tests' deposits and nobody else's. */
  const pastDay = () =>
    `${randomInt(2001, 2024)}-${String(randomInt(1, 13)).padStart(2, '0')}-${String(randomInt(1, 29)).padStart(2, '0')}`;

  /** A deposit made over HTTP, paid at the fake PSP and credited by the real sync: its bank reference is the PSP's. */
  async function credit(toman: number): Promise<Credited> {
    const userId = `b5_${randomUUID().slice(0, 12)}`;
    const res = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', `b5-${randomUUID()}`)
      .send({ userId, amount: String(toman) })
      .expect(201);
    const id = (res.body as { depositId: string }).depositId;
    const [{ psp_token: token }] = await ds.query<{ psp_token: string }[]>(
      'SELECT psp_token FROM deposits WHERE id = $1',
      [id],
    );
    psp.pay(token);
    await handler.handle({
      messageId: randomUUID(),
      type: 'job.deposit.sync',
      aggregateType: 'DEPOSIT',
      aggregateId: id,
      occurredAt: new Date().toISOString(),
      payload: { depositId: id },
    });
    const [d] = await ds.query<{ psp_ref_id: string; credited: string }[]>(
      `SELECT psp_ref_id, credited_rial::text AS credited FROM deposits WHERE id = $1 AND status = 'SUCCEEDED'`,
      [id],
    );
    return {
      id,
      userId,
      reference: d.psp_ref_id,
      amountRial: BigInt(d.credited),
    };
  }
  /** Moves the credits onto `day` (10:00 Tehran time). */
  const creditedOn = (day: string, ...deposits: Credited[]) =>
    ds.query(
      `UPDATE deposits SET completed_at = (($2::date)::timestamp AT TIME ZONE 'Asia/Tehran') + interval '10 hours'
        WHERE id = ANY($1::uuid[])`,
      [deposits.map((d) => d.id), day],
    );
  const listed = (d: Credited, amountRial = d.amountRial) => ({
    reference: d.reference,
    amountRial,
    token: `A0${d.id.slice(0, 12)}`,
  });
  const run = (body?: object) => {
    const r = request(app.getHttpServer()).post('/reconciliation/run');
    return body === undefined ? r.send() : r.send(body);
  };
  const runsOn = async (day: string) =>
    (
      await ds.query<{ n: string }[]>(
        'SELECT count(*)::text AS n FROM reconciliation_runs WHERE settlement_date = $1',
        [day],
      )
    )[0].n;
  const view = (res: request.Response) => res.body as RunView;
  const typesOf = (v: RunView) => v.mismatches.map((m) => m.type).sort();

  describe('a clean day', () => {
    it('every credited payment is in the file, written in the PSP’s own styles: all matched, nothing reported, the run stored with the exact file', async () => {
      const day = pastDay();
      const deposits = [
        await credit(1000),
        await credit(2500),
        await credit(3000),
      ];
      await creditedOn(day, ...deposits);
      const file = settlementFile(
        day,
        deposits.map((d) => listed(d)),
      );
      psp.setSettlement(day, file);

      const res = await run({ date: day });

      expect(res.status).toBe(201);
      expect(view(res)).toMatchObject({
        date: day,
        settlementRows: 3,
        matched: 3,
        mismatchCount: 0,
        mismatches: [],
      });
      expect(psp.settlementDays.at(-1)).toBe(day);
      const [stored] = await ds.query<{ raw_csv: string; matched: number }[]>(
        'SELECT raw_csv, matched FROM reconciliation_runs WHERE id = $1',
        [view(res).runId],
      );
      expect(stored.matched).toBe(3);
      const withoutBom = (text: string) =>
        text.replace(String.fromCharCode(0xfeff), '');
      expect(withoutBom(stored.raw_csv)).toBe(withoutBom(file));
      const again = await request(app.getHttpServer()).get(
        `/reconciliation/runs/${view(res).runId}`,
      );
      expect(again.status).toBe(200);
      expect(again.body).toEqual(res.body);
    });
  });

  describe('seeded mismatches are all reported, each with the right type (B5)', () => {
    const day = pastDay();
    let a: Credited;
    let b: Credited;
    let c: Credited;
    let d: Credited;
    const foreign = '9876543210';
    let res: request.Response;

    beforeAll(async () => {
      [a, b, c, d] = [
        await credit(1000),
        await credit(2000),
        await credit(3000),
        await credit(4000),
      ];
      await creditedOn(day, a, b, c, d);
      const file = withLines(
        settlementFile(day, [
          listed(a),
          listed(b, b.amountRial + 10_000n),
          listed(d),
          listed(d),
          { reference: foreign, amountRial: 4_800_000n },
        ]),
        'this is not a row',
        `9,1405/01/01,1111111111,${DEPOSIT_TYPE},"1,000",dated another day`,
      );
      psp.setSettlement(day, file);
      res = await run({ date: day });
    });

    it('the run is created and counts what matched', () => {
      expect(res.status).toBe(201);
      expect(view(res)).toMatchObject({
        date: day,
        settlementRows: 7,
        matched: 2,
        mismatchCount: 6,
      });
    });

    it('MISSING_IN_LEDGER: the PSP settled a payment we never credited', () => {
      expect(
        view(res).mismatches.filter((m) => m.type === 'MISSING_IN_LEDGER'),
      ).toMatchObject([
        {
          reference: foreign,
          depositId: null,
          ourAmountRial: null,
          theirAmountRial: '4800000',
        },
      ]);
    });

    it('MISSING_IN_SETTLEMENT: we credited a payment the PSP did not list', () => {
      expect(
        view(res).mismatches.filter((m) => m.type === 'MISSING_IN_SETTLEMENT'),
      ).toMatchObject([
        {
          reference: c.reference,
          depositId: c.id,
          ourAmountRial: c.amountRial.toString(),
          theirAmountRial: null,
        },
      ]);
    });

    it('AMOUNT_MISMATCH: both sides have it, for different amounts, in rial', () => {
      expect(
        view(res).mismatches.filter((m) => m.type === 'AMOUNT_MISMATCH'),
      ).toMatchObject([
        {
          reference: b.reference,
          depositId: b.id,
          ourAmountRial: b.amountRial.toString(),
          theirAmountRial: (b.amountRial + 10_000n).toString(),
        },
      ]);
    });

    it('DUPLICATE_IN_SETTLEMENT: the repeated row, still matched once against our credit', () => {
      expect(
        view(res).mismatches.filter(
          (m) => m.type === 'DUPLICATE_IN_SETTLEMENT',
        ),
      ).toMatchObject([
        {
          reference: d.reference,
          depositId: d.id,
          theirAmountRial: d.amountRial.toString(),
          details: { count: 2, amountsDiffer: false },
        },
      ]);
    });

    it('UNREADABLE_ROW: the line that is not a row, and the row dated another day', () => {
      const rows = view(res).mismatches.filter(
        (m) => m.type === 'UNREADABLE_ROW',
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.details.reason).sort()).toEqual([
        'DATE_MISMATCH',
        'WRONG_COLUMN_COUNT',
      ]);
    });

    it('reports exactly these six and nothing else', () => {
      expect(typesOf(view(res))).toEqual([
        'AMOUNT_MISMATCH',
        'DUPLICATE_IN_SETTLEMENT',
        'MISSING_IN_LEDGER',
        'MISSING_IN_SETTLEMENT',
        'UNREADABLE_ROW',
        'UNREADABLE_ROW',
      ]);
    });

    it('stores the same mismatches, in the same order, and a later GET returns them', async () => {
      const stored = await ds.query<
        { type: string; reference: string | null }[]
      >(
        'SELECT type, reference FROM reconciliation_mismatches WHERE run_id = $1 ORDER BY id',
        [view(res).runId],
      );
      expect(stored).toEqual(
        view(res).mismatches.map((m) => ({
          type: m.type,
          reference: m.reference,
        })),
      );
      const again = await request(app.getHttpServer()).get(
        `/reconciliation/runs/${view(res).runId}`,
      );
      expect(again.body).toEqual(res.body);
    });

    it('changes nothing in the ledger: deposits, balances, journals and the outbox are exactly as they were', async () => {
      const users = [a, b, c, d].map((x) => x.userId);
      const ids = [a, b, c, d].map((x) => x.id);
      const snapshot = async () => ({
        deposits: await ds.query<unknown[]>(
          `SELECT id, status, credited_rial::text, psp_ref_id, completed_at, updated_at, needs_review
             FROM deposits WHERE id = ANY($1::uuid[]) ORDER BY id`,
          [ids],
        ),
        accounts: await ds.query<unknown[]>(
          `SELECT user_id, kind, balance_minor::text, updated_at FROM accounts
            WHERE user_id = ANY($1) ORDER BY user_id, kind`,
          [users],
        ),
        journals: await ds.query<unknown[]>(
          `SELECT count(*)::text AS n FROM journals WHERE ref_id = ANY($1::uuid[])`,
          [ids],
        ),
        postings: await ds.query<unknown[]>(
          `SELECT count(*)::text AS n FROM postings WHERE user_id = ANY($1)`,
          [users],
        ),
        outbox: await ds.query<unknown[]>(
          `SELECT count(*)::text AS n FROM outbox WHERE aggregate_id = ANY($1)`,
          [[...users, ...ids]],
        ),
      });
      const before = await snapshot();

      await run({ date: day });
      await run({ date: day });

      expect(await snapshot()).toEqual(before);
    });
  });

  describe('no file, or not the file we know: 503, and no run is stored', () => {
    it.each([
      ['503', '503'],
      ['a 200 with an HTML page from a proxy', 'html'],
      ['a 200 with a JSON error', 'json'],
      ['an empty 200', 'empty'],
    ] as const)('the PSP answers %s', async (_name, fault) => {
      const day = pastDay();
      psp.settlementFault = fault;
      const res = await run({ date: day });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect(await runsOn(day)).toBe('0');
    });

    it('a file with another header', async () => {
      const day = pastDay();
      psp.setSettlement(day, 'a,b,c\r\n1,2,3\r\n');
      const res = await run({ date: day });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'The settlement file is not in the expected format',
      });
      expect(await runsOn(day)).toBe('0');
    });

    it('a PSP that drops the connection', async () => {
      const day = pastDay();
      psp.settlementFault = 'reset';
      const res = await run({ date: day });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect(await runsOn(day)).toBe('0');
    });
  });

  describe('what may be asked', () => {
    const refused: [string, object][] = [
      ['not a date', { date: 'abc' }],
      ['a day that does not exist', { date: '2026-13-45' }],
      ['February 30th', { date: '2026-02-30' }],
      ['a Jalali date', { date: '1405/08/15' }],
      ['a number', { date: 5 }],
      ['a time as well', { date: '2026-11-05T10:00:00Z' }],
      ['a day in the future', { date: '2999-01-01' }],
      ['an unknown field', { date: '2026-11-05', force: true }],
    ];
    it.each(refused)('%s is 400', async (_name, body) => {
      const res = await run(body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('malformed JSON is 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/reconciliation/run')
        .set('content-type', 'application/json')
        .send('{"date": ');
      expect(res.status).toBe(400);
    });

    it('no body means today (Tehran, by the database clock), and needs no Idempotency-Key', async () => {
      const [{ day }] = await ds.query<{ day: string }[]>(
        `SELECT to_char(now() AT TIME ZONE 'Asia/Tehran', 'YYYY-MM-DD') AS day`,
      );
      const res = await run();
      expect(res.status).toBe(201);
      expect(view(res).date).toBe(day);
      expect(psp.settlementDays.at(-1)).toBe(day);
    });

    it('an unknown or malformed run id is 404', async () => {
      for (const id of [randomUUID(), 'not-a-run']) {
        const res = await request(app.getHttpServer()).get(
          `/reconciliation/runs/${id}`,
        );
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      }
    });
  });

  describe('runs on their own', () => {
    it('a payment credited on another day is found by its reference: not missing from the ledger', async () => {
      const day = pastDay();
      const other = pastDay();
      const d = await credit(1000);
      await creditedOn(other, d);
      psp.setSettlement(day, settlementFile(day, [listed(d)]));

      const res = await run({ date: day });

      expect(view(res)).toMatchObject({ matched: 1, mismatchCount: 0 });
    });

    it('a credit just after the day began is marked as possibly belonging to the previous day’s file', async () => {
      const day = pastDay();
      const d = await credit(1000);
      await ds.query(
        `UPDATE deposits SET completed_at = (($2::date)::timestamp AT TIME ZONE 'Asia/Tehran') + interval '90 seconds' WHERE id = $1`,
        [d.id, day],
      );
      psp.setSettlement(day, settlementFile(day, []));
      const res = await run({ date: day });
      expect(view(res).mismatches).toMatchObject([
        {
          type: 'MISSING_IN_SETTLEMENT',
          reference: d.reference,
          details: { nearDayStart: true },
        },
      ]);
    });

    it('two runs at once for the same day make two independent reports', async () => {
      const day = pastDay();
      const d = await credit(1000);
      await creditedOn(day, d);
      psp.setSettlement(
        day,
        settlementFile(day, [listed(d, 1n + d.amountRial)]),
      );
      const [x, y] = await Promise.all([
        run({ date: day }),
        run({ date: day }),
      ]);
      expect(x.status).toBe(201);
      expect(y.status).toBe(201);
      expect(view(x).runId).not.toBe(view(y).runId);
      expect(typesOf(view(x))).toEqual(['AMOUNT_MISMATCH']);
      expect(typesOf(view(y))).toEqual(['AMOUNT_MISMATCH']);
      expect(await runsOn(day)).toBe('2');
    });

    it('a file carrying a NUL byte is stored: the byte becomes U+FFFD, the run is not lost', async () => {
      const day = pastDay();
      const nul = String.fromCharCode(0);
      psp.setSettlement(
        day,
        withLines(
          settlementFile(day, []),
          `1,${nul},${nul},${nul},${nul},${nul}`,
        ),
      );
      const res = await run({ date: day });
      expect(res.status).toBe(201);
      const [stored] = await ds.query<{ raw_csv: string }[]>(
        'SELECT raw_csv FROM reconciliation_runs WHERE id = $1',
        [view(res).runId],
      );
      expect(stored.raw_csv).toContain(String.fromCharCode(0xfffd));
      expect(stored.raw_csv).not.toContain(nul);
    });

    it('a day of 12,000 settled payments that are not ours: all reported, all stored, though one INSERT could not hold them', async () => {
      const day = pastDay();
      const rows = Array.from({ length: 12_000 }, (_, i) => ({
        reference: String(3_000_000_000 + i),
        amountRial: 10_000n + BigInt(i),
      }));
      psp.setSettlement(day, settlementFile(day, rows));
      const started = Date.now();
      const res = await run({ date: day });
      expect(res.status).toBe(201);
      expect(view(res)).toMatchObject({
        settlementRows: 12_000,
        matched: 0,
        mismatchCount: 12_000,
      });
      expect(typesOf(view(res)).every((t) => t === 'MISSING_IN_LEDGER')).toBe(
        true,
      );
      expect(Date.now() - started).toBeLessThan(45_000);
      const [{ n }] = await ds.query<{ n: string }[]>(
        'SELECT count(*)::text AS n FROM reconciliation_mismatches WHERE run_id = $1',
        [view(res).runId],
      );
      expect(n).toBe('12000');
    }, 90_000);

    it('uses the header and type text of the real file', () => {
      expect(SETTLEMENT_HEADER).toHaveLength(6);
      expect(DEPOSIT_TYPE.length).toBeGreaterThan(0);
    });
  });
});
