import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { APP_OPTIONS, configureBodyParsing } from '../../../common/http';
import { connectTestDb, describeDb } from '../../../database/int-testing';
import { TransactionRunner } from '../../../database/transaction-runner';
import { HttpPspClient } from '../../integrations/psp/http-psp.client';
import { FakePspServer } from '../../integrations/psp/testing/fake-psp-server';
import { newLedgerService } from '../../ledger/testing';
import { DepositSyncHandler } from '../handlers/deposit-sync.handler';
import { DepositLifecycleRepository } from '../repositories/deposit-lifecycle.repository';

interface Pending {
  id: string;
  token: string;
  userId: string;
}

describeDb('POST /webhooks/psp/callback/:depositId (real PostgreSQL)', () => {
  let ds: DataSource;
  let app: NestExpressApplication;
  let handler: DepositSyncHandler;
  const psp = new FakePspServer();
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
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

  /** A real PENDING deposit of 1,000 toman (10,000 rial), created over HTTP against the fake PSP. */
  async function pending(): Promise<Pending> {
    const userId = `d4_${randomUUID().slice(0, 12)}`;
    const res = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', `d4-${randomUUID()}`)
      .send({ userId, amount: '1000' })
      .expect(201);
    const id = (res.body as { depositId: string }).depositId;
    const [{ psp_token: token }] = await ds.query<{ psp_token: string }[]>(
      'SELECT psp_token FROM deposits WHERE id = $1',
      [id],
    );
    return { id, token, userId };
  }

  const callback = (
    pathId: string,
    payload: object | string,
    contentType = 'application/json',
  ) =>
    request(app.getHttpServer())
      .post(`/webhooks/psp/callback/${pathId}`)
      .set('content-type', contentType)
      .send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const hint = (d: Pending, status: string, extra: object = {}) => ({
    token: d.token,
    orderId: d.id,
    status,
    ...extra,
  });

  const depositRow = async (id: string) =>
    (
      await ds.query<
        {
          status: string;
          failure_reason: string | null;
          needs_review: boolean;
          review_reason: string | null;
          due_now: boolean;
          credited_rial: string | null;
        }[]
      >(
        `SELECT status, failure_reason, needs_review, review_reason,
                credited_rial::text,
                next_check_at <= now() AS due_now
           FROM deposits WHERE id = $1`,
        [id],
      )
    )[0];
  const syncJobs = (id: string) =>
    ds.query<{ payload: unknown; routing_key: string }[]>(
      `SELECT payload, routing_key FROM outbox WHERE aggregate_id = $1 ORDER BY id`,
      [id],
    );
  const journals = async (id: string) =>
    (
      await ds.query<{ n: string }[]>(
        'SELECT count(*)::text AS n FROM journals WHERE ref_id = $1',
        [id],
      )
    )[0].n;
  const accounts = (userId: string) =>
    ds.query<{ kind: string; b: string }[]>(
      `SELECT kind, balance_minor::text AS b FROM accounts WHERE user_id = $1 ORDER BY kind`,
      [userId],
    );
  const recorded = (reference: string) =>
    ds.query<
      {
        source: string;
        outcome: string;
        signature_valid: boolean | null;
        raw_body: string;
      }[]
    >(
      'SELECT source, outcome, signature_valid, raw_body FROM inbound_events WHERE reference = $1 ORDER BY id',
      [reference],
    );
  const runSync = (id: string) =>
    handler.handle({
      messageId: randomUUID(),
      type: 'job.deposit.sync',
      aggregateType: 'DEPOSIT',
      aggregateId: id,
      occurredAt: new Date().toISOString(),
      payload: { depositId: id },
    });

  describe('a callback is a hint: it changes no money (PSP-04/06/07)', () => {
    it('a NOK callback for a payment that was paid: 200, still PENDING, a sync is queued, nothing booked (PSP-06)', async () => {
      const d = await pending();
      psp.pay(d.token);
      const raw = JSON.stringify(hint(d, 'NOK'));

      const started = Date.now();
      const res = await callback(d.id, raw).expect(200);
      const took = Date.now() - started;

      expect(res.body).toEqual({ received: true });
      expect(took).toBeLessThan(500);
      expect(await depositRow(d.id)).toMatchObject({
        status: 'PENDING',
        due_now: true,
        needs_review: false,
      });
      expect(await journals(d.id)).toBe('0');
      expect(await accounts(d.userId)).toEqual([]);
      expect(await syncJobs(d.id)).toEqual([
        {
          routing_key: 'job.deposit.sync',
          payload: { depositId: d.id, trigger: 'CALLBACK' },
        },
      ]);
      expect(await recorded(d.id)).toEqual([
        {
          source: 'PSP_CALLBACK',
          outcome: 'ACCEPTED',
          signature_valid: null,
          raw_body: raw,
        },
      ]);
    });

    it('a NOK callback does not fail the deposit: the sync still credits it once the PSP says paid', async () => {
      const d = await pending();
      psp.pay(d.token);
      await callback(d.id, hint(d, 'NOK')).expect(200);

      await runSync(d.id);

      expect(await depositRow(d.id)).toMatchObject({
        status: 'SUCCEEDED',
        credited_rial: '10000',
      });
    });

    it('a forged-amount callback is stored but never used: the sync credits the verified 10,000 rial, not the claimed 100,000 (PSP-07)', async () => {
      const d = await pending();
      psp.pay(d.token);
      const raw = JSON.stringify(hint(d, 'OK', { amount: '100000' }));

      await callback(d.id, raw).expect(200);
      expect(await journals(d.id)).toBe('0');
      expect(await accounts(d.userId)).toEqual([]);
      expect((await recorded(d.id))[0].raw_body).toBe(raw);

      await runSync(d.id);

      expect(await depositRow(d.id)).toMatchObject({
        status: 'SUCCEEDED',
        credited_rial: '10000',
        needs_review: false,
      });
      expect(await accounts(d.userId)).toEqual([
        { kind: 'AVAILABLE', b: '10000' },
        { kind: 'DEBT', b: '0' },
        { kind: 'FROZEN', b: '0' },
      ]);
    });

    it('an OK callback for a payment nobody paid changes nothing either: the sync finds INIT and keeps it PENDING', async () => {
      const d = await pending();
      await callback(d.id, hint(d, 'OK')).expect(200);

      await runSync(d.id);

      expect(await depositRow(d.id)).toMatchObject({ status: 'PENDING' });
      expect(await journals(d.id)).toBe('0');
    });
  });

  describe('matching the callback to our deposit', () => {
    it.each([
      ['an unknown deposit id', () => randomUUID()],
      ['an id that is not a uuid', () => `not-a-deposit-${randomUUID()}`],
    ])(
      '%s → 200, recorded as UNKNOWN_REFERENCE, nothing queued',
      async (_c, make) => {
        const ref = make();
        await callback(ref, {
          token: 'A0x',
          orderId: ref,
          status: 'OK',
        }).expect(200);
        expect(await recorded(ref)).toMatchObject([
          { outcome: 'UNKNOWN_REFERENCE' },
        ]);
        expect(await syncJobs(ref)).toEqual([]);
      },
    );

    it("a token that is not the deposit's → 200, recorded as MISMATCH, nothing queued", async () => {
      const d = await pending();
      await callback(d.id, { ...hint(d, 'OK'), token: 'A0forged' }).expect(200);
      expect(await recorded(d.id)).toMatchObject([{ outcome: 'MISMATCH' }]);
      expect(await syncJobs(d.id)).toEqual([]);
      expect((await depositRow(d.id)).due_now).toBe(false);
    });

    it("another deposit's token on this deposit's URL → MISMATCH", async () => {
      const a = await pending();
      const b = await pending();
      await callback(a.id, hint(b, 'OK', { orderId: a.id })).expect(200);
      expect(await recorded(a.id)).toMatchObject([{ outcome: 'MISMATCH' }]);
      expect(await syncJobs(a.id)).toEqual([]);
      expect(await syncJobs(b.id)).toEqual([]);
    });

    it("an orderId that is not the URL's deposit → MISMATCH", async () => {
      const a = await pending();
      const b = await pending();
      await callback(a.id, hint(a, 'OK', { orderId: b.id })).expect(200);
      expect(await recorded(a.id)).toMatchObject([{ outcome: 'MISMATCH' }]);
      expect(await syncJobs(a.id)).toEqual([]);
    });

    it.each([
      ['an empty JSON object', '{}', 'application/json'],
      ['a JSON array', '[1,2]', 'application/json'],
      ['plain text', 'status=OK', 'text/plain'],
      [
        'form-encoded',
        'token=A0x&status=OK',
        'application/x-www-form-urlencoded',
      ],
      ['JSON that is cut off', '{"token": ', 'application/json'],
      ['JSON with trailing garbage', '{"status":"OK"}xx', 'application/json'],
      ['single-quoted JSON', "{'status':'OK'}", 'application/json'],
      [
        'a UTF-8 BOM and then JSON',
        '\ufeff{"status":"OK"}',
        'application/json',
      ],
    ])(
      '%s → 200, recorded exactly as received, MISMATCH, nothing queued',
      async (_c, raw, type) => {
        const d = await pending();
        await callback(d.id, raw, type).expect(200);
        expect(await recorded(d.id)).toMatchObject([
          { outcome: 'MISMATCH', raw_body: raw },
        ]);
        expect(await syncJobs(d.id)).toEqual([]);
      },
    );

    it('a body with NUL bytes is recorded (NUL stored as U+FFFD, which text columns can hold) and answered 200', async () => {
      const d = await pending();
      await callback(d.id, 'a\u0000b', 'text/plain').expect(200);
      expect(await recorded(d.id)).toMatchObject([
        { outcome: 'MISMATCH', raw_body: 'a\uFFFDb' },
      ]);
    });

    it('invalid UTF-8 bytes are recorded and answered 200 too', async () => {
      const d = await pending();
      await request(app.getHttpServer())
        .post(`/webhooks/psp/callback/${d.id}`)
        .set('content-type', 'application/json')
        .send(Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]))
        .expect(200);
      expect(await recorded(d.id)).toMatchObject([{ outcome: 'MISMATCH' }]);
    });

    it('a body over the 100 KB limit is refused by the parser: 400, nothing recorded', async () => {
      const d = await pending();
      await callback(d.id, JSON.stringify({ pad: 'x'.repeat(150_000) })).expect(
        400,
      );
      expect(await recorded(d.id)).toEqual([]);
    });

    it('ordinary routes still refuse malformed JSON with 400', async () => {
      await request(app.getHttpServer())
        .post('/deposits')
        .set('content-type', 'application/json')
        .set('Idempotency-Key', `d4-${randomUUID()}`)
        .send('{"userId": ')
        .expect(400);
    });

    it('a deposit whose payment was never issued (CREATED, no token) → MISMATCH', async () => {
      const id = randomUUID();
      await ds.query(
        `INSERT INTO deposits (id, user_id, amount_rial, status, expires_at)
         VALUES ($1, 'd4_created', 10000, 'CREATED', now() + interval '1 day')`,
        [id],
      );
      await callback(id, { token: 'A0x', orderId: id, status: 'OK' }).expect(
        200,
      );
      expect(await recorded(id)).toMatchObject([{ outcome: 'MISMATCH' }]);
    });
  });

  describe('duplicates and final deposits', () => {
    it('five copies of one callback (PSP-05): all 200, all recorded, the deposit unchanged', async () => {
      const d = await pending();
      for (let i = 0; i < 5; i++) {
        await callback(d.id, hint(d, 'OK')).expect(200);
      }
      expect(await recorded(d.id)).toHaveLength(5);
      expect(await depositRow(d.id)).toMatchObject({ status: 'PENDING' });
      expect(await journals(d.id)).toBe('0');
    });

    it('five copies and five syncs credit exactly once', async () => {
      const d = await pending();
      psp.pay(d.token);
      for (let i = 0; i < 5; i++) {
        await callback(d.id, hint(d, 'OK')).expect(200);
      }
      await Promise.all([1, 2, 3, 4, 5].map(() => runSync(d.id)));
      expect(await journals(d.id)).toBe('1');
      expect(await accounts(d.userId)).toContainEqual({
        kind: 'AVAILABLE',
        b: '10000',
      });
    });

    it.each([
      [
        'SUCCEEDED',
        `status = 'SUCCEEDED', credited_rial = amount_rial, psp_ref_id = 'R' || id, completed_at = now(), next_check_at = NULL`,
      ],
      [
        'FAILED (PSP_FAILED)',
        `status = 'FAILED', failure_reason = 'PSP_FAILED', completed_at = now(), next_check_at = NULL`,
      ],
    ])(
      'a callback for a %s deposit → IGNORED_FINAL, nothing queued, nothing flagged',
      async (_c, set) => {
        const d = await pending();
        await ds.query(`UPDATE deposits SET ${set} WHERE id = $1`, [d.id]);
        await callback(d.id, hint(d, 'OK')).expect(200);
        expect(await recorded(d.id)).toMatchObject([
          { outcome: 'IGNORED_FINAL' },
        ]);
        expect(await syncJobs(d.id)).toEqual([]);
        expect((await depositRow(d.id)).needs_review).toBe(false);
      },
    );

    describe('after the deposit expired (D15, ADR-11)', () => {
      const expire = async (d: Pending): Promise<void> => {
        await ds.query(
          `UPDATE deposits SET status = 'FAILED', failure_reason = 'EXPIRED', completed_at = now(), next_check_at = NULL WHERE id = $1`,
          [d.id],
        );
      };

      it('a callback that says paid flags the late payment and still moves no money', async () => {
        const d = await pending();
        await expire(d);
        await callback(d.id, hint(d, 'OK')).expect(200);
        expect(await depositRow(d.id)).toMatchObject({
          status: 'FAILED',
          failure_reason: 'EXPIRED',
          needs_review: true,
          review_reason: 'LATE_PAYMENT_AFTER_EXPIRY',
        });
        expect(await recorded(d.id)).toMatchObject([
          { outcome: 'IGNORED_FINAL' },
        ]);
        expect(await syncJobs(d.id)).toEqual([]);
        expect(await journals(d.id)).toBe('0');
      });

      it('a NOK callback flags nothing', async () => {
        const d = await pending();
        await expire(d);
        await callback(d.id, hint(d, 'NOK')).expect(200);
        expect((await depositRow(d.id)).needs_review).toBe(false);
      });
    });
  });
});
