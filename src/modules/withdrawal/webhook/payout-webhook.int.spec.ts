import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { APP_OPTIONS, configureBodyParsing } from '../../../common/http';
import { Money } from '../../../common/money';
import { loadConfig } from '../../../config/app-config';
import { connectTestDb, describeDb } from '../../../database/int-testing';
import { TransactionRunner } from '../../../database/transaction-runner';
import { newLedgerService } from '../../ledger/testing';

const IBAN = 'IR330566736841214070501510';

describeDb('POST /webhooks/payout (real PostgreSQL)', () => {
  let ds: DataSource;
  let app: NestExpressApplication;
  let runner: TransactionRunner;
  const secret = loadConfig().payout.webhookSecret;
  const ledger = newLedgerService();

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    ds = await connectTestDb();
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 20_000,
    });
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRole('api')],
    }).compile();
    app = ref.createNestApplication<NestExpressApplication>(APP_OPTIONS);
    configureBodyParsing(app);
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    if (ds?.isInitialized) await ds.destroy();
    jest.restoreAllMocks();
  });

  /** A real PENDING withdrawal of 150,000 toman, made over HTTP; its next check is the 30 s safety net. */
  async function withdrawal(): Promise<{ id: string; userId: string }> {
    const userId = `x7_${randomUUID().slice(0, 12)}`;
    await runner.run((tx) =>
      ledger.creditUser(tx, {
        userId,
        amount: Money.toman(500_000n),
        source: 'OPS_ADJUSTMENTS',
        kind: 'ADJUSTMENT_CREDIT',
        refId: randomUUID(),
      }),
    );
    const res = await request(app.getHttpServer())
      .post('/withdrawals')
      .set('Idempotency-Key', `x7-${randomUUID()}`)
      .send({ userId, currency: 'IRT', amount: '150000', destination: IBAN });
    return { id: (res.body as { withdrawalId: string }).withdrawalId, userId };
  }

  const body = (requestId: string, status: string, extra = '') =>
    `{"event":"transfer.updated","eventId":"evt_${randomUUID().slice(0, 8)}","requestId":"${requestId}","trackingId":"TRK1","status":"${status}"${extra},"amount":"1500000","currency":"IRR","occurredAt":"2026-11-04T10:00:00.000Z"}`;
  const sign = (raw: string, key = secret) =>
    createHmac('sha256', key).update(raw).digest('hex');
  const deliver = (raw: string, signature: string | null) => {
    const r = request(app.getHttpServer())
      .post('/webhooks/payout')
      .set('content-type', 'application/json')
      .set('x-event-id', 'evt_test');
    if (signature !== null) r.set('x-signature', signature);
    return r.send(raw);
  };

  const snapshot = async (id: string, userId: string) => {
    const [w] = await ds.query<{ status: string; next_check_at: Date }[]>(
      'SELECT status, next_check_at FROM withdrawals WHERE id = $1',
      [id],
    );
    const [{ syncs }] = await ds.query<{ syncs: string }[]>(
      `SELECT count(*)::text AS syncs FROM outbox WHERE routing_key = 'job.withdrawal.sync' AND aggregate_id = $1`,
      [id],
    );
    const balances = await ds.query<{ kind: string; b: string }[]>(
      `SELECT kind, balance_minor::text AS b FROM accounts WHERE user_id = $1 ORDER BY kind`,
      [userId],
    );
    return { ...w, syncs, balances };
  };
  const recorded = (reference: string) =>
    ds.query<
      {
        outcome: string;
        signature_valid: boolean;
        raw_body: string;
        event_id: string;
      }[]
    >(
      'SELECT outcome, signature_valid, raw_body, event_id FROM inbound_events WHERE reference = $1 ORDER BY id',
      [reference],
    );

  it('a forged FAILED webhook gets 401 and changes nothing (PAY-10), but is recorded', async () => {
    const { id, userId } = await withdrawal();
    const before = await snapshot(id, userId);
    // status FAILED, no `reason`, a signature that does not match.
    const raw = body(id, 'FAILED');

    const res = await deliver(raw, sign(raw, 'guessed-secret'));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      code: 'INVALID_SIGNATURE',
      message: 'Invalid signature',
    });
    expect(await snapshot(id, userId)).toEqual(before);
    expect(await recorded(id)).toEqual([
      {
        outcome: 'REJECTED_SIGNATURE',
        signature_valid: false,
        raw_body: raw,
        event_id: 'evt_test',
      },
    ]);
  });

  it('a webhook with no signature at all gets 401 too', async () => {
    const { id, userId } = await withdrawal();
    const before = await snapshot(id, userId);
    expect((await deliver(body(id, 'FAILED'), null)).status).toBe(401);
    expect(await snapshot(id, userId)).toEqual(before);
  });

  it('a valid webhook schedules a sync now and applies nothing itself', async () => {
    const { id, userId } = await withdrawal();
    const before = await snapshot(id, userId);
    const raw = body(id, 'SUCCEEDED', ',"reason":null');

    const started = Date.now();
    const res = await deliver(raw, sign(raw));
    const took = Date.now() - started;

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(took).toBeLessThan(500); // the target is under 50 ms
    const after = await snapshot(id, userId);
    expect(after.status).toBe('PENDING'); // SUCCEEDED in the body is a hint, not applied
    expect(after.balances).toEqual(before.balances);
    expect(after.next_check_at.getTime()).toBeLessThan(
      before.next_check_at.getTime(),
    );
    expect(after.syncs).toBe('1');
    const [{ payload }] = await ds.query<{ payload: unknown }[]>(
      `SELECT payload FROM outbox WHERE routing_key = 'job.withdrawal.sync' AND aggregate_id = $1`,
      [id],
    );
    expect(payload).toEqual({ withdrawalId: id, trigger: 'WEBHOOK' });
    expect(await recorded(id)).toMatchObject([
      { outcome: 'ACCEPTED', signature_valid: true, raw_body: raw },
    ]);
  });

  describe('a body that is not valid JSON', () => {
    const garbage = ['{"requestId": ', '{{{{', "{'requestId':'x'}", '[1,2,3'];

    it.each(garbage)(
      'unsigned %j → 401 and recorded as REJECTED_SIGNATURE, exactly as received',
      async (raw) => {
        const res = await deliver(raw, null);
        expect(res.status).toBe(401);
        const [row] = await ds.query<{ outcome: string; raw_body: string }[]>(
          `SELECT outcome, raw_body FROM inbound_events
            WHERE source = 'PAYOUT_WEBHOOK' AND raw_body = $1
            ORDER BY id DESC LIMIT 1`,
          [raw],
        );
        expect(row).toEqual({ outcome: 'REJECTED_SIGNATURE', raw_body: raw });
      },
    );

    it.each(garbage)(
      'signed %j → 200 and recorded as UNKNOWN_REFERENCE: nothing to schedule, but nothing lost',
      async (raw) => {
        const res = await deliver(raw, sign(raw));
        expect(res.status).toBe(200);
        const [row] = await ds.query<
          { outcome: string; signature_valid: boolean }[]
        >(
          `SELECT outcome, signature_valid FROM inbound_events
            WHERE source = 'PAYOUT_WEBHOOK' AND raw_body = $1
            ORDER BY id DESC LIMIT 1`,
          [raw],
        );
        expect(row).toEqual({
          outcome: 'UNKNOWN_REFERENCE',
          signature_valid: true,
        });
      },
    );

    it('a signed body with NUL bytes is recorded and answered 200; the signature is still checked on the exact bytes', async () => {
      const raw = `{"requestId":"x\u0000y"`;
      expect((await deliver(raw, sign(raw))).status).toBe(200);
      const [row] = await ds.query<{ outcome: string; raw_body: string }[]>(
        `SELECT outcome, raw_body FROM inbound_events WHERE source = 'PAYOUT_WEBHOOK' AND raw_body LIKE '{"requestId":"x%y"' ORDER BY id DESC LIMIT 1`,
      );
      expect(row).toEqual({
        outcome: 'UNKNOWN_REFERENCE',
        raw_body: '{"requestId":"x\uFFFDy"',
      });
      expect((await deliver(raw, sign('different'))).status).toBe(401);
    });

    it('ordinary routes still refuse malformed JSON with 400', async () => {
      await request(app.getHttpServer())
        .post('/withdrawals')
        .set('content-type', 'application/json')
        .set('Idempotency-Key', `x7-${randomUUID()}`)
        .send('{"userId": ')
        .expect(400);
    });
  });

  it('verifies the raw bytes: unusual spacing signed as sent is valid', async () => {
    const { id } = await withdrawal();
    const raw = `{ "requestId" : "${id}",   "status":"PROCESSING" }`;
    expect((await deliver(raw, sign(raw))).status).toBe(200);
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect((await deliver(reserialised, sign(raw))).status).toBe(401);
  });

  it.each([
    ['an unknown withdrawal id', () => randomUUID()],
    ['a requestId that is not ours at all', () => `rq-${randomUUID()}`],
  ])(
    '%s → 200, recorded as UNKNOWN_REFERENCE, nothing scheduled',
    async (_c, makeId) => {
      const ref = makeId();
      const raw = body(ref, 'SUCCEEDED');
      const res = await deliver(raw, sign(raw));
      expect(res.status).toBe(200);
      expect(await recorded(ref)).toMatchObject([
        { outcome: 'UNKNOWN_REFERENCE', signature_valid: true },
      ]);
      const [{ n }] = await ds.query<{ n: string }[]>(
        'SELECT count(*)::text AS n FROM outbox WHERE aggregate_id = $1',
        [ref],
      );
      expect(n).toBe('0');
    },
  );

  it('a duplicated delivery is recorded each time and only schedules another harmless pull', async () => {
    const { id } = await withdrawal();
    const raw = body(id, 'SUCCEEDED', ',"reason":null');
    for (let i = 0; i < 3; i++)
      expect((await deliver(raw, sign(raw))).status).toBe(200);
    expect(await recorded(id)).toHaveLength(3);
    const [{ status }] = await ds.query<{ status: string }[]>(
      'SELECT status FROM withdrawals WHERE id = $1',
      [id],
    );
    expect(status).toBe('PENDING');
  });
});
