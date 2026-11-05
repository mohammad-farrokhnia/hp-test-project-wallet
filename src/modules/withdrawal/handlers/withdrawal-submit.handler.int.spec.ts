import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { Money } from '../../../common/money';
import { AppConfig, loadConfig } from '../../../config/app-config';
import { connectTestDb, describeDb } from '../../../database/int-testing';
import { TransactionRunner } from '../../../database/transaction-runner';
import { newIdempotencyService } from '../../idempotency/testing';
import { HttpPayoutClient } from '../../integrations/payout/http-payout.client';
import {
  PayoutClient,
  PayoutRequest,
  SubmitOutcome,
  TransferSnapshot,
} from '../../integrations/payout';
import { newLedgerService } from '../../ledger/testing';
import { Envelope, OutboxService } from '../../messaging';
import { OutboxRepository } from '../../messaging/outbox/outbox.repository';
import { buildPolicies } from '../domain/withdrawal-policy';
import { DailyLimitRepository } from '../repositories/daily-limit.repository';
import { PayoutAttemptsRepository } from '../repositories/payout-attempts.repository';
import { WithdrawalLifecycleRepository } from '../repositories/withdrawal-lifecycle.repository';
import { WithdrawalsRepository } from '../repositories/withdrawals.repository';
import { WithdrawalService } from '../withdrawal.service';
import { WithdrawalSubmitHandler } from './withdrawal-submit.handler';

const IBAN = 'IR330566736841214070501510';

/** A payout service scripted per test; uses the real adapter's request body. */
class FakePayout implements PayoutClient {
  readonly calls: PayoutRequest[] = [];
  private readonly format = new HttpPayoutClient('http://unused', 1000);
  constructor(public answer: (r: PayoutRequest) => Promise<SubmitOutcome>) {}
  requestBody(r: PayoutRequest) {
    return this.format.requestBody(r);
  }
  async submit(r: PayoutRequest): Promise<SubmitOutcome> {
    this.calls.push(r);
    return this.answer(r);
  }
  getTransfer(): never {
    throw new Error('not used by submit');
  }
}

const snapshot = (
  r: PayoutRequest,
  over: Partial<TransferSnapshot> = {},
): TransferSnapshot => ({
  requestId: r.requestId,
  trackingId: 'TRK1',
  status: 'ACCEPTED',
  reason: null,
  amount: r.amount,
  destination: r.destination,
  ...over,
});
const wire = (
  status: number | null,
  body: unknown = null,
  error: string | null = null,
) => ({
  requestBody: {},
  httpStatus: status,
  responseBody: body,
  error,
});
const accepted = (r: PayoutRequest): SubmitOutcome => ({
  kind: 'ACCEPTED',
  snapshot: snapshot(r),
  ...wire(202, { status: 'ACCEPTED' }),
});
const ambiguous = (
  reason: string,
  status: number | null = null,
): SubmitOutcome => ({
  kind: 'AMBIGUOUS',
  reason,
  ...wire(status, status ? { error: reason } : null, status ? null : reason),
});

describeDb('WithdrawalSubmitHandler (real PostgreSQL)', () => {
  let ds: DataSource;
  let runner: TransactionRunner;
  let config: AppConfig;
  let withdrawals: WithdrawalService;
  const ledger = newLedgerService();
  const outbox = new OutboxService(new OutboxRepository());

  beforeAll(async () => {
    for (const level of ['log', 'warn'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation();
    }
    ds = await connectTestDb();
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 20_000,
    });
    config = loadConfig();
    withdrawals = new WithdrawalService(
      runner,
      newIdempotencyService(),
      ledger,
      outbox,
      new WithdrawalsRepository(),
      new DailyLimitRepository(),
      buildPolicies(config.limits),
      config,
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    jest.restoreAllMocks();
  });

  const handler = (payout: PayoutClient, cfg: AppConfig = config) =>
    new WithdrawalSubmitHandler(
      runner,
      new WithdrawalsRepository(),
      new WithdrawalLifecycleRepository(),
      new PayoutAttemptsRepository(),
      outbox,
      payout,
      cfg,
    );
  const job = (withdrawalId: string): Envelope => ({
    messageId: randomUUID(),
    type: 'job.withdrawal.submit',
    aggregateType: 'WITHDRAWAL',
    aggregateId: withdrawalId,
    occurredAt: new Date().toISOString(),
    payload: { withdrawalId },
  });

  /** A real PENDING withdrawal of 150,000 toman, made through POST /withdrawals' service. */
  async function pending(): Promise<{ id: string; userId: string }> {
    const userId = `x6_${randomUUID().slice(0, 12)}`;
    await runner.run((tx) =>
      ledger.creditUser(tx, {
        userId,
        amount: Money.toman(500_000n),
        source: 'OPS_ADJUSTMENTS',
        kind: 'ADJUSTMENT_CREDIT',
        refId: randomUUID(),
      }),
    );
    const { response } = await withdrawals.request(
      {
        userId,
        amount: Money.toman(150_000n),
        destination: IBAN,
        body: { userId },
      },
      `x6-${randomUUID()}`,
    );
    return {
      id: (response.body as { withdrawalId: string }).withdrawalId,
      userId,
    };
  }

  const state = async (id: string) =>
    (
      await ds.query<
        {
          status: string;
          submit_attempts: number;
          needs_review: boolean;
          review_reason: string | null;
          provider_status: string | null;
          provider_tracking_id: string | null;
          check_in: number;
          submitted: boolean;
        }[]
      >(
        `SELECT status, submit_attempts, needs_review, review_reason, provider_status,
                provider_tracking_id, round(extract(epoch FROM next_check_at - now()))::int AS check_in,
                submitted_at IS NOT NULL AS submitted
           FROM withdrawals WHERE id = $1`,
        [id],
      )
    )[0];
  const attempts = (id: string) =>
    ds.query<
      {
        attempt_no: number;
        outcome: string | null;
        http_status: number | null;
        finished: boolean;
        request_body: unknown;
      }[]
    >(
      `SELECT attempt_no, outcome, http_status, finished_at IS NOT NULL AS finished, request_body
         FROM payout_attempts WHERE withdrawal_id = $1 ORDER BY attempt_no`,
      [id],
    );
  const frozenOf = async (userId: string) =>
    (
      await ds.query<{ b: string }[]>(
        `SELECT balance_minor::text AS b FROM accounts WHERE user_id = $1 AND kind = 'FROZEN' AND currency = 'IRR'`,
        [userId],
      )
    )[0].b;

  it('records the attempt BEFORE the call, then moves to PROCESSING on 202 (W1, W2)', async () => {
    const { id } = await pending();
    let seenDuringCall: unknown;
    const payout = new FakePayout(async (r) => {
      seenDuringCall = { state: await state(id), attempts: await attempts(id) };
      return accepted(r);
    });

    await handler(payout).handle(job(id));

    expect(payout.calls).toEqual([
      {
        requestId: id,
        destinationType: 'IBAN',
        destination: IBAN,
        amount: Money.toman(150_000n),
      },
    ]);
    expect(seenDuringCall).toMatchObject({
      state: { status: 'SUBMITTING', submit_attempts: 1, submitted: true },
      attempts: [
        {
          attempt_no: 1,
          finished: false,
          outcome: null,
          request_body: {
            requestId: id,
            type: 'IBAN',
            destination: IBAN,
            amount: '1500000',
            currency: 'IRR',
          },
        },
      ],
    });
    const after = await state(id);
    expect(after).toMatchObject({
      status: 'PROCESSING',
      provider_status: 'ACCEPTED',
      provider_tracking_id: 'TRK1',
    });
    expect(after.check_in).toBeGreaterThanOrEqual(9);
    expect(after.check_in).toBeLessThanOrEqual(11);
    expect(await attempts(id)).toMatchObject([
      { outcome: 'ACCEPTED', http_status: 202, finished: true },
    ]);
  });

  describe('an ambiguous outcome leaves SUBMITTING with a next check, never FAILED (W3)', () => {
    it.each([
      [
        '503 UPSTREAM_UNAVAILABLE (PAY-03)',
        ambiguous('UPSTREAM_UNAVAILABLE', 503),
      ],
      ['a timeout (PAY-04)', ambiguous('timeout')],
      ['a connection reset (PAY-04)', ambiguous('ECONNRESET')],
    ])('%s', async (_c, outcome) => {
      const { id, userId } = await pending();
      await handler(new FakePayout(() => Promise.resolve(outcome))).handle(
        job(id),
      );

      const s = await state(id);
      expect(s.status).toBe('SUBMITTING');
      expect(s.check_in).toBeGreaterThanOrEqual(1);
      expect(s.check_in).toBeLessThanOrEqual(3);
      expect(await attempts(id)).toMatchObject([
        { outcome: 'AMBIGUOUS', finished: true },
      ]);
      expect(await frozenOf(userId)).toBe('1500000'); // the money stays frozen
    });

    it('backs off 2 s, 5 s, 15 s, then 60 s, and is still SUBMITTING after every try', async () => {
      const { id } = await pending();
      const payout = new FakePayout(() =>
        Promise.resolve(ambiguous('timeout')),
      );
      const seen: number[] = [];
      for (let i = 0; i < 5; i++) {
        await handler(payout).handle(job(id));
        const s = await state(id);
        expect(s.status).toBe('SUBMITTING');
        seen.push(s.check_in);
      }
      expect(seen).toEqual([2, 5, 15, 60, 60]);
      expect(payout.calls.map((c) => c.requestId)).toEqual(Array(5).fill(id)); // never a new requestId
      expect((await attempts(id)).map((a) => a.attempt_no)).toEqual([
        1, 2, 3, 4, 5,
      ]);
    });
  });

  it('a 200 replay that matches ours → PROCESSING, attempt REPLAYED (W2)', async () => {
    const { id } = await pending();
    await handler(
      new FakePayout((r) =>
        Promise.resolve({
          kind: 'REPLAYED',
          snapshot: snapshot(r),
          mismatches: [],
          ...wire(200),
        }),
      ),
    ).handle(job(id));
    expect((await state(id)).status).toBe('PROCESSING');
    expect(await attempts(id)).toMatchObject([{ outcome: 'REPLAYED' }]);
  });

  it('a 200 replay with another amount → stays SUBMITTING, flagged REPLAY_MISMATCH, check in 5 min (W4)', async () => {
    const { id, userId } = await pending();
    await handler(
      new FakePayout((r) =>
        Promise.resolve({
          kind: 'REPLAYED',
          snapshot: snapshot(r, { amount: Money.rial(2_000_000n) }),
          mismatches: ['amount'],
          ...wire(200),
        }),
      ),
    ).handle(job(id));
    const s = await state(id);
    expect(s).toMatchObject({
      status: 'SUBMITTING',
      needs_review: true,
      review_reason: 'REPLAY_MISMATCH',
    });
    expect(s.check_in).toBeGreaterThanOrEqual(299);
    expect(await attempts(id)).toMatchObject([{ outcome: 'MISMATCH' }]);
    expect(await frozenOf(userId)).toBe('1500000');
  });

  it('a 400 → stays SUBMITTING (not FAILED) and asks for a sync now; a GET decides (W6)', async () => {
    const { id } = await pending();
    await handler(
      new FakePayout(() =>
        Promise.resolve({
          kind: 'REJECTED',
          ...wire(400, { error: 'INVALID_AMOUNT' }),
          error: 'INVALID_AMOUNT',
        }),
      ),
    ).handle(job(id));
    const s = await state(id);
    expect(s.status).toBe('SUBMITTING');
    expect(s.check_in).toBeLessThanOrEqual(0);
    expect(await attempts(id)).toMatchObject([
      { outcome: 'REJECTED', http_status: 400 },
    ]);
    const [{ n }] = await ds.query<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM outbox WHERE routing_key = 'job.withdrawal.sync' AND aggregate_id = $1`,
      [id],
    );
    expect(n).toBe('1');
  });

  it('two workers on the same job: one submit, the other skips the locked row', async () => {
    const { id } = await pending();
    const payout = new FakePayout(async (r) => {
      await sleep(300);
      return accepted(r);
    });
    await Promise.all([
      handler(payout).handle(job(id)),
      handler(payout).handle(job(id)),
    ]);
    expect(payout.calls).toHaveLength(1);
    expect(await attempts(id)).toHaveLength(1);
  });

  it('does nothing once PROCESSING, for an unknown id, or while an attempt is in flight', async () => {
    const { id } = await pending();
    const payout = new FakePayout((r) => Promise.resolve(accepted(r)));
    await handler(payout).handle(job(id));
    await handler(payout).handle(job(id)); // already PROCESSING
    await handler(payout).handle(job(randomUUID())); // unknown
    expect(payout.calls).toHaveLength(1);

    const second = await pending();
    let release!: () => void;
    const slow = new FakePayout(async (r) => {
      await new Promise<void>((ok) => (release = ok));
      return accepted(r);
    });
    const first = handler(slow).handle(job(second.id));
    while ((await attempts(second.id)).length === 0) await sleep(10);
    await handler(slow).handle(job(second.id)); // attempt 1 still in flight
    expect(slow.calls).toHaveLength(1);
    release();
    await first;
  });

  it('after a crash mid-call, resubmits the SAME requestId once the lease has passed', async () => {
    const { id } = await pending();
    const crashing = new FakePayout(() =>
      Promise.reject(new Error('worker died mid-call')),
    );
    await expect(handler(crashing).handle(job(id))).rejects.toThrow(
      'worker died',
    );
    expect(await attempts(id)).toMatchObject([
      { attempt_no: 1, finished: false },
    ]);

    const payout = new FakePayout((r) => Promise.resolve(accepted(r)));
    await handler(payout).handle(job(id)); // still inside the lease: nothing
    expect(payout.calls).toHaveLength(0);

    await ds.query(
      `UPDATE payout_attempts SET started_at = now() - interval '1 minute' WHERE withdrawal_id = $1`,
      [id],
    );
    await handler(payout).handle(job(id));
    expect(payout.calls.map((c) => c.requestId)).toEqual([id]);
    expect((await attempts(id)).map((a) => [a.attempt_no, a.finished])).toEqual(
      [
        [1, false],
        [2, true],
      ],
    );
    expect((await state(id)).status).toBe('PROCESSING');
  });

  it('refuses a lease that does not outlast the HTTP timeout', () => {
    const tooShort = loadConfig({
      ...process.env,
      WITHDRAWAL_SUBMIT_LEASE_SECONDS: '5',
      HTTP_TIMEOUT_MS: '5000',
    });
    expect(() =>
      handler(new FakePayout(() => Promise.reject(new Error())), tooShort),
    ).toThrow(/WITHDRAWAL_SUBMIT_LEASE_SECONDS/);
  });
});
