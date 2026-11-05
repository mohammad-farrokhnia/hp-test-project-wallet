import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { TransactionRunner, Tx } from '../../database/transaction-runner';
import { HttpPspClient } from '../integrations/psp/http-psp.client';
import { FakePspServer } from '../integrations/psp/testing/fake-psp-server';
import { newLedgerService } from '../ledger/testing';
import type { DueJob } from '../scheduler/due-work';
import { DepositDueWork } from './deposit.due-work';
import { DepositSyncHandler } from './handlers/deposit-sync.handler';
import { DepositLifecycleRepository } from './repositories/deposit-lifecycle.repository';

const ALL = 100_000;

class Rollback extends Error {}

interface Deposit {
  id: string;
  token: string;
  userId: string;
}

interface WalletBody {
  balances: { currency: string; available: string }[];
}

/**
 * The deposit from the payer's click to the wallet, the way production runs it: HTTP API, PSP callbacks,
 * the sweeper's `DepositDueWork` and the `DepositSyncHandler`, against a fake PSP scripted per finding.
 */
describeDb('deposit lifecycle against the fake PSP (real PostgreSQL)', () => {
  let ds: DataSource;
  let app: INestApplication<App>;
  let handler: DepositSyncHandler;
  const psp = new FakePspServer();
  const dueWork = new DepositDueWork();
  const verify503 = new Set<string>();
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation();
    }
    ds = await connectTestDb();
    psp.script = {
      onCreate: () => 'ok',
      verify503: (token, attempt) => verify503.has(token) && attempt === 1,
    };
    const pspUrl = await psp.start();
    Object.assign(process.env, {
      PSP_BASE_URL: pspUrl,
      HTTP_TIMEOUT_MS: '1000',
      DEPOSIT_CREATE_LEASE_SECONDS: '2',
    });
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRole('api')],
    }).compile();
    app = ref.createNestApplication({ rawBody: true });
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

  /** A deposit of 1,000 toman (10,000 rial) made over HTTP: `PENDING`, first check in 15 s. */
  async function open(): Promise<Deposit> {
    const userId = `d7_${randomUUID().slice(0, 12)}`;
    const res = await request(app.getHttpServer())
      .post('/deposits')
      .set('Idempotency-Key', `d7-${randomUUID()}`)
      .send({ userId, amount: '1000' })
      .expect(201);
    const id = (res.body as { depositId: string }).depositId;
    const [{ psp_token: token }] = await ds.query<{ psp_token: string }[]>(
      'SELECT psp_token FROM deposits WHERE id = $1',
      [id],
    );
    return { id, token, userId };
  }

  const callback = (d: Deposit, status: string, extra: object = {}) =>
    request(app.getHttpServer())
      .post(`/webhooks/psp/callback/${d.id}`)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ token: d.token, orderId: d.id, status, ...extra }))
      .expect(200);

  const view = async (d: Deposit) =>
    (await request(app.getHttpServer()).get(`/deposits/${d.id}`).expect(200))
      .body as Record<string, unknown>;
  const available = async (d: Deposit) =>
    (
      (
        await request(app.getHttpServer())
          .get(`/wallets/${d.userId}`)
          .expect(200)
      ).body as WalletBody
    ).balances.find((b) => b.currency === 'IRT')?.available;
  const row = async (d: Deposit) =>
    (
      await ds.query<
        {
          status: string;
          needs_review: boolean;
          review_reason: string | null;
          next_in: number | null;
        }[]
      >(
        `SELECT status, needs_review, review_reason,
                extract(epoch FROM next_check_at - now())::float AS next_in
           FROM deposits WHERE id = $1`,
        [d.id],
      )
    )[0];
  const journals = async (d: Deposit) =>
    (
      await ds.query<{ n: string }[]>(
        `SELECT count(*)::text AS n FROM journals WHERE ref_id = $1`,
        [d.id],
      )
    )[0].n;

  /** Time passing: the deposit's next check arrives. */
  const dueNow = (d: Deposit) =>
    ds.query(
      `UPDATE deposits SET next_check_at = now() - interval '1 second' WHERE id = $1`,
      [d.id],
    );
  const makeExpired = (d: Deposit) =>
    ds.query(
      `UPDATE deposits SET created_at = now() - interval '2 days', expires_at = now() - interval '1 minute' WHERE id = $1`,
      [d.id],
    );

  /**
   * One sweeper round and the worker that consumes it, for one deposit: the real `DepositDueWork` decides whether it is due,
   * the real handler syncs it. Claims in a rolled-back transaction so the other suites' deposits are not touched.
   * @returns how many sync jobs the sweeper made for the deposit
   */
  async function sweep(d: Deposit): Promise<number> {
    let jobs: DueJob[] = [];
    try {
      await ds.transaction(async (tx: Tx) => {
        jobs = await dueWork.claimDue(tx, ALL, 60);
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    const mine = jobs.filter((j) => j.aggregateId === d.id);
    for (const j of mine) {
      await handler.handle({
        messageId: randomUUID(),
        type: j.job,
        aggregateType: j.aggregateType,
        aggregateId: j.aggregateId,
        occurredAt: new Date().toISOString(),
        payload: j.payload,
      });
    }
    return mine.length;
  }

  it('happy path: the payer pays, the callback arrives, the sync credits the wallet once', async () => {
    const d = await open();
    expect(await view(d)).toMatchObject({
      status: 'PENDING',
      amount: '1000',
      creditedAmount: null,
    });
    expect(await available(d)).toBe('0');

    psp.pay(d.token);
    await callback(d, 'OK');
    expect(await sweep(d)).toBe(1);

    expect(await view(d)).toMatchObject({
      status: 'SUCCEEDED',
      creditedAmount: '1000',
      needsReview: false,
    });
    expect(await available(d)).toBe('1000');
    expect(await journals(d)).toBe('1');

    await callback(d, 'OK');
    expect(await sweep(d)).toBe(0);
    expect(await available(d)).toBe('1000');
  });

  describe('lost callback (PSP-05): the poller credits within a minute', () => {
    it('no callback ever comes: polls follow 15 s, 15 s, 30 s, and the paid payment is credited on the next one', async () => {
      const d = await open();
      const waits: number[] = [];
      for (let i = 0; i < 3; i++) {
        waits.push((await row(d)).next_in as number);
        await dueNow(d);
        expect(await sweep(d)).toBe(1);
        expect(await row(d)).toMatchObject({ status: 'PENDING' });
      }
      expect(waits[0]).toBeGreaterThan(10);
      expect(waits[0]).toBeLessThanOrEqual(15);
      const next = (await row(d)).next_in as number;
      expect(next).toBeGreaterThan(25);
      expect(next).toBeLessThanOrEqual(30);

      psp.pay(d.token);
      expect(await sweep(d)).toBe(0);
      await dueNow(d);
      expect(await sweep(d)).toBe(1);

      expect(await view(d)).toMatchObject({
        status: 'SUCCEEDED',
        creditedAmount: '1000',
      });
      expect(await available(d)).toBe('1000');
    });

    it('a deposit is never more than a minute from its next check while it is young', async () => {
      const d = await open();
      for (let i = 0; i < 6; i++) {
        expect((await row(d)).next_in as number).toBeLessThanOrEqual(60);
        await dueNow(d);
        await sweep(d);
      }
    });
  });

  describe('lying callbacks', () => {
    it('NOK for a payment that was paid, then OK and its duplicates (PSP-06, PSP-05): credited once', async () => {
      const d = await open();
      psp.pay(d.token);
      await callback(d, 'NOK');
      expect(await row(d)).toMatchObject({ status: 'PENDING' });
      for (let i = 0; i < 3; i++) await callback(d, 'OK');

      await sweep(d);
      await sweep(d);

      expect(await view(d)).toMatchObject({
        status: 'SUCCEEDED',
        creditedAmount: '1000',
      });
      expect(await available(d)).toBe('1000');
      expect(await journals(d)).toBe('1');
    });

    it('NOK for a payment nobody paid and OK for one nobody paid change nothing', async () => {
      const d = await open();
      await callback(d, 'NOK');
      await callback(d, 'OK');
      await sweep(d);
      expect(await view(d)).toMatchObject({ status: 'PENDING' });
      expect(await available(d)).toBe('0');
    });
  });

  it('forged amount (PSP-07): the callback claims ten times as much, the wallet gets what verify says', async () => {
    const d = await open();
    psp.pay(d.token);
    await callback(d, 'OK', { amount: '100000' });
    await sweep(d);

    expect(await view(d)).toMatchObject({
      status: 'SUCCEEDED',
      amount: '1000',
      creditedAmount: '1000',
      needsReview: false,
    });
    expect(await available(d)).toBe('1000');
  });

  it('verify 503 (PSP-09): not applied, the deposit stays PENDING, and the retry 5 s later credits it', async () => {
    const d = await open();
    verify503.add(d.token);
    psp.pay(d.token);
    await callback(d, 'OK');

    await sweep(d);
    expect(await row(d)).toMatchObject({ status: 'PENDING' });
    expect((await row(d)).next_in as number).toBeLessThanOrEqual(5);
    expect(await available(d)).toBe('0');

    await dueNow(d);
    await sweep(d);

    expect(await view(d)).toMatchObject({
      status: 'SUCCEEDED',
      creditedAmount: '1000',
    });
    expect(await available(d)).toBe('1000');
    expect(psp.verifyCalls(d.token)).toBe(2);
  });

  it('reversal (PSP-10): the PSP reversed an unverified payment, so the deposit fails, is flagged, and credits nothing', async () => {
    const d = await open();
    psp.pay(d.token);
    const payment = psp.payments.get(d.token);
    if (!payment) throw new Error('payment is gone');
    payment.status = 'REVERSED';
    await callback(d, 'OK');

    await sweep(d);

    expect(await view(d)).toMatchObject({
      status: 'FAILED',
      failureReason: 'PSP_REVERSED',
      creditedAmount: null,
      needsReview: true,
    });
    expect(await available(d)).toBe('0');
    expect(await journals(d)).toBe('0');
    expect(psp.verifyCalls(d.token)).toBe(0);
  });

  describe('expiry (ADR-11)', () => {
    it('an unpaid deposit expires after 24 hours; a payment after that is flagged and never verified', async () => {
      const d = await open();
      await makeExpired(d);
      await dueNow(d);
      expect(await sweep(d)).toBe(1);

      expect(await view(d)).toMatchObject({
        status: 'FAILED',
        failureReason: 'EXPIRED',
        needsReview: false,
      });

      psp.pay(d.token);
      await callback(d, 'OK');

      expect(await row(d)).toMatchObject({
        status: 'FAILED',
        needs_review: true,
        review_reason: 'LATE_PAYMENT_AFTER_EXPIRY',
      });
      expect(await sweep(d)).toBe(0);
      expect(psp.verifyCalls(d.token)).toBe(0);
      expect(await available(d)).toBe('0');
      expect(await journals(d)).toBe('0');
    });

    it('a payer who pays on the last day is credited: expiry only takes deposits still in INIT', async () => {
      const d = await open();
      psp.pay(d.token);
      await makeExpired(d);
      await dueNow(d);
      await sweep(d);
      expect(await view(d)).toMatchObject({
        status: 'SUCCEEDED',
        creditedAmount: '1000',
      });
    });
  });
});
