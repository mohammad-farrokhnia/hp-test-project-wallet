import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Money } from '../../../common/money';
import { AppConfig, loadConfig } from '../../../config/app-config';
import { connectTestDb, describeDb } from '../../../database/int-testing';
import { TransactionRunner } from '../../../database/transaction-runner';
import { newIdempotencyService } from '../../idempotency/testing';
import { HttpPayoutClient } from '../../integrations/payout/http-payout.client';
import {
  LookupOutcome,
  PayoutClient,
  PayoutRequest,
  SubmitOutcome,
  TransferStatus,
} from '../../integrations/payout';
import { newLedgerService } from '../../ledger/testing';
import { Envelope, OutboxService } from '../../messaging';
import { OutboxRepository } from '../../messaging/outbox/outbox.repository';
import { InvariantsService } from '../../operations/invariants/invariants.service';
import { buildPolicies } from '../domain/withdrawal-policy';
import { DailyLimitRepository } from '../repositories/daily-limit.repository';
import { PayoutAttemptsRepository } from '../repositories/payout-attempts.repository';
import { WithdrawalLifecycleRepository } from '../repositories/withdrawal-lifecycle.repository';
import { WithdrawalsRepository } from '../repositories/withdrawals.repository';
import { WithdrawalDueWork } from '../withdrawal.due-work';
import { WithdrawalService } from '../withdrawal.service';
import { WithdrawalSubmitHandler } from './withdrawal-submit.handler';
import { WithdrawalSyncHandler } from './withdrawal-sync.handler';

const IBAN = 'IR330566736841214070501510';
const TRC20 = 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y79bP';

/** A payout service whose GET answers as scripted; submit answers once, for setting a state up. */
class FakePayout implements PayoutClient {
  getCalls = 0;
  private readonly format = new HttpPayoutClient('http://unused', 1000);
  constructor(
    private readonly lookup: () => LookupOutcome = () => ({
      kind: 'UNAVAILABLE',
      reason: 'x',
    }),
    private readonly submitAs: (r: PayoutRequest) => SubmitOutcome = accepted,
  ) {}
  requestBody(r: PayoutRequest) {
    return this.format.requestBody(r);
  }
  submit(r: PayoutRequest) {
    return Promise.resolve(this.submitAs(r));
  }
  getTransfer() {
    this.getCalls++;
    return Promise.resolve(this.lookup());
  }
}
const wire = (status: number | null) => ({
  requestBody: {},
  httpStatus: status,
  responseBody: null,
  error: null,
});
function accepted(r: PayoutRequest): SubmitOutcome {
  return {
    kind: 'ACCEPTED',
    snapshot: {
      requestId: r.requestId,
      trackingId: 'TRK1',
      status: 'ACCEPTED',
      reason: null,
      amount: r.amount,
      destination: r.destination,
    },
    ...wire(202),
  };
}
const ambiguous = (): SubmitOutcome => ({
  kind: 'AMBIGUOUS',
  reason: 'timeout',
  ...wire(null),
});
const rejected = (): SubmitOutcome => ({
  kind: 'REJECTED',
  ...wire(400),
  error: 'INVALID_AMOUNT',
});

describeDb(
  'WithdrawalSyncHandler: the state machine on real PostgreSQL',
  () => {
    let ds: DataSource;
    let runner: TransactionRunner;
    let config: AppConfig;
    let service: WithdrawalService;
    const ledger = newLedgerService();
    const outbox = new OutboxService(new OutboxRepository());

    beforeAll(async () => {
      for (const level of ['log', 'warn'] as const)
        jest.spyOn(Logger.prototype, level).mockImplementation();
      ds = await connectTestDb();
      runner = new TransactionRunner(ds, {
        lockTimeoutMs: 10_000,
        statementTimeoutMs: 20_000,
      });
      config = loadConfig();
      service = new WithdrawalService(
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

    const repos = () => ({
      lifecycle: new WithdrawalLifecycleRepository(),
      attempts: new PayoutAttemptsRepository(),
    });
    const syncWith = (payout: PayoutClient) => {
      const { lifecycle, attempts } = repos();
      return new WithdrawalSyncHandler(
        runner,
        lifecycle,
        attempts,
        new DailyLimitRepository(),
        ledger,
        outbox,
        payout,
        config,
      );
    };
    const submitWith = (payout: PayoutClient) => {
      const { lifecycle, attempts } = repos();
      return new WithdrawalSubmitHandler(
        runner,
        new WithdrawalsRepository(),
        lifecycle,
        attempts,
        outbox,
        payout,
        config,
      );
    };
    const job = (
      type: string,
      id: string,
      payload: Record<string, string> = {},
    ): Envelope => ({
      messageId: randomUUID(),
      type,
      aggregateType: 'WITHDRAWAL',
      aggregateId: id,
      occurredAt: new Date().toISOString(),
      payload: { withdrawalId: id, ...payload },
    });
    const found = (
      status: TransferStatus,
      reason: string | null = null,
    ): LookupOutcome => ({
      kind: 'FOUND',
      snapshot: {
        requestId: 'x',
        trackingId: 'TRK1',
        status,
        reason,
        amount: Money.rial(1n),
        destination: IBAN,
      },
    });
    /** One sync run that sees `lookup`. */
    const sync = (
      id: string,
      lookup: LookupOutcome,
      payload: Record<string, string> = {},
    ) => {
      const payout = new FakePayout(() => lookup);
      return syncWith(payout)
        .handle(job('job.withdrawal.sync', id, payload))
        .then(() => payout);
    };

    /** A withdrawal of 150,000 toman (or 10 USDT) by a user funded with 500,000 toman (or 30 USDT). */
    async function withdrawal(
      after: 'PENDING' | 'PROCESSING' | 'AMBIGUOUS' | 'REJECTED' = 'PROCESSING',
      currency: 'IRR' | 'USDT' = 'IRR',
    ) {
      const userId = `x8_${randomUUID().slice(0, 12)}`;
      const usdt = currency === 'USDT';
      await runner.run((tx) =>
        ledger.creditUser(tx, {
          userId,
          amount: usdt ? Money.microUsdt(30_000_000n) : Money.toman(500_000n),
          source: 'OPS_ADJUSTMENTS',
          kind: 'ADJUSTMENT_CREDIT',
          refId: randomUUID(),
        }),
      );
      const { response } = await service.request(
        {
          userId,
          amount: usdt ? Money.microUsdt(10_000_000n) : Money.toman(150_000n),
          destination: usdt ? TRC20 : IBAN,
          body: { userId },
        },
        `x8-${randomUUID()}`,
      );
      const id = (response.body as { withdrawalId: string }).withdrawalId;
      if (after !== 'PENDING') {
        const as =
          after === 'PROCESSING'
            ? accepted
            : after === 'AMBIGUOUS'
              ? ambiguous
              : rejected;
        await submitWith(new FakePayout(undefined, as)).handle(
          job('job.withdrawal.submit', id),
        );
      }
      return { id, userId };
    }

    const row = async (id: string) =>
      (
        await ds.query<
          {
            status: string;
            failure_reason: string | null;
            provider_status: string | null;
            provider_reason: string | null;
            return_reason: string | null;
            returned: boolean;
            completed: boolean;
            needs_review: boolean;
            review_reason: string | null;
            check_in: number | null;
          }[]
        >(
          `SELECT status, failure_reason, provider_status, provider_reason, return_reason,
                returned_at IS NOT NULL AS returned, completed_at IS NOT NULL AS completed,
                needs_review, review_reason,
                round(extract(epoch FROM next_check_at - now()))::int AS check_in
           FROM withdrawals WHERE id = $1`,
          [id],
        )
      )[0];
    const journals = async (id: string) =>
      Object.fromEntries(
        (
          await ds.query<{ kind: string; n: number }[]>(
            `SELECT kind, count(*)::int AS n FROM journals WHERE ref_id = $1 GROUP BY kind`,
            [id],
          )
        ).map((r) => [r.kind, r.n]),
      );
    const money = async (
      userId: string,
      currency = 'IRR',
    ): Promise<Record<string, string | null>> => {
      const rows = await ds.query<{ kind: string; b: string }[]>(
        `SELECT kind, balance_minor::text AS b FROM accounts WHERE user_id = $1 AND currency = $2`,
        [userId, currency],
      );
      const usage = await ds.query<{ used: string }[]>(
        `SELECT used_rial::text AS used FROM withdrawal_daily_usage WHERE user_id = $1`,
        [userId],
      );
      return {
        ...Object.fromEntries(rows.map((r) => [r.kind, r.b])),
        usage: usage[0]?.used ?? null,
      };
    };
    const violations = async (userId: string) => {
      const report = await new InvariantsService(
        runner,
        ledger,
        service,
      ).check();
      return report.checks.flatMap((c) =>
        c.violations.filter((v) => Object.values(v).includes(userId)),
      );
    };

    describe('out-of-order and duplicate statuses produce exactly one terminal journal (PAY-11)', () => {
      it('a replayed history ending SUCCEEDED, then a late FAILED: one SETTLE, no RELEASE', async () => {
        const { id, userId } = await withdrawal();
        for (const s of [
          'PROCESSING',
          'SUCCEEDED',
          'PROCESSING',
          'SUCCEEDED',
          'SUCCEEDED',
          'FAILED',
          'ACCEPTED',
        ] as const) {
          await sync(id, found(s));
        }
        expect(await journals(id)).toEqual({
          WITHDRAWAL_FREEZE: 1,
          WITHDRAWAL_SETTLE: 1,
        });
        expect(await row(id)).toMatchObject({
          status: 'SUCCEEDED',
          completed: true,
          failure_reason: null,
        });
        expect(await money(userId)).toEqual({
          AVAILABLE: '3500000',
          FROZEN: '0',
          DEBT: '0',
          usage: '1500000',
        });
        expect(await violations(userId)).toEqual([]);
      });

      it('FAILED first, then SUCCEEDED and the rest: one RELEASE, and the daily limit given back', async () => {
        const { id, userId } = await withdrawal();
        await sync(id, found('FAILED', 'INVALID_IBAN'));
        for (const s of [
          'SUCCEEDED',
          'PROCESSING',
          'FAILED',
          'RETURNED',
        ] as const)
          await sync(id, found(s));

        expect(await journals(id)).toEqual({
          WITHDRAWAL_FREEZE: 1,
          WITHDRAWAL_RELEASE: 1,
        });
        expect(await row(id)).toMatchObject({
          status: 'FAILED',
          failure_reason: 'PROVIDER_FAILED',
          completed: true,
          check_in: null,
        });
        expect(await money(userId)).toEqual({
          AVAILABLE: '5000000',
          FROZEN: '0',
          DEBT: '0',
          usage: '0',
        });
        expect(await violations(userId)).toEqual([]);
      });

      it('10 concurrent syncs disagreeing (SUCCEEDED vs FAILED): one terminal journal, money consistent with it', async () => {
        const { id, userId } = await withdrawal();
        await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            sync(id, found(i % 2 ? 'SUCCEEDED' : 'FAILED')),
          ),
        );
        const j = await journals(id);
        const terminal =
          (j.WITHDRAWAL_SETTLE ?? 0) + (j.WITHDRAWAL_RELEASE ?? 0);
        expect(terminal).toBe(1);
        const { status } = await row(id);
        const m = await money(userId);
        if (j.WITHDRAWAL_SETTLE) {
          expect(status).toBe('SUCCEEDED');
          expect(m).toMatchObject({
            AVAILABLE: '3500000',
            FROZEN: '0',
            usage: '1500000',
          });
        } else {
          expect(status).toBe('FAILED');
          expect(m).toMatchObject({
            AVAILABLE: '5000000',
            FROZEN: '0',
            usage: '0',
          });
        }
        expect(await violations(userId)).toEqual([]);
      });
    });

    describe('returns (PAY-07)', () => {
      it('RETURNED as the first final status: settle and return together (W11), the limit kept', async () => {
        const { id, userId } = await withdrawal();
        await sync(id, found('RETURNED', 'ACCOUNT_CLOSED'));
        await sync(id, found('RETURNED', 'ACCOUNT_CLOSED')); // duplicate
        expect(await journals(id)).toEqual({
          WITHDRAWAL_FREEZE: 1,
          WITHDRAWAL_SETTLE: 1,
          WITHDRAWAL_RETURN: 1,
        });
        expect(await row(id)).toMatchObject({
          status: 'SUCCEEDED',
          returned: true,
          return_reason: 'ACCOUNT_CLOSED',
        });
        expect(await money(userId)).toEqual({
          AVAILABLE: '5000000',
          FROZEN: '0',
          DEBT: '0',
          usage: '1500000',
        });
        expect(await violations(userId)).toEqual([]);
      });

      it('SUCCEEDED, then RETURNED later (W10): one return; the USDT fee is kept', async () => {
        const { id, userId } = await withdrawal('PROCESSING', 'USDT');
        await sync(id, found('SUCCEEDED'));
        expect((await row(id)).check_in).toBeGreaterThan(250); // watched for a return
        await sync(id, found('RETURNED', 'ACCOUNT_CLOSED'));
        await sync(id, found('RETURNED', 'ACCOUNT_CLOSED'));

        expect(await journals(id)).toEqual({
          WITHDRAWAL_FREEZE: 1,
          WITHDRAWAL_SETTLE: 1,
          WITHDRAWAL_RETURN: 1,
        });
        // 30 − (10 + 1 fee) + 10 returned = 29 USDT: the fee stays with FEE_REVENUE.
        expect(await money(userId, 'USDT')).toMatchObject({
          AVAILABLE: '29000000',
          FROZEN: '0',
        });
        expect((await row(id)).check_in).toBeNull();
        expect(await violations(userId)).toEqual([]);
      });
    });

    describe('a GET that finds nothing (404)', () => {
      it('after an ambiguous submit: resubmit the same requestId (W5)', async () => {
        const { id } = await withdrawal('AMBIGUOUS');
        await sync(id, { kind: 'NOT_FOUND' });
        expect(await row(id)).toMatchObject({ status: 'SUBMITTING' });
        const [{ n }] = await ds.query<{ n: string }[]>(
          `SELECT count(*)::text AS n FROM outbox WHERE routing_key = 'job.withdrawal.submit' AND aggregate_id = $1`,
          [id],
        );
        expect(n).toBe('2'); // the request's own job, and the resubmit
      });

      it('after a 400: FAILED as PROVIDER_REJECTED, released (W6)', async () => {
        const { id, userId } = await withdrawal('REJECTED');
        await sync(id, { kind: 'NOT_FOUND' });
        expect(await row(id)).toMatchObject({
          status: 'FAILED',
          failure_reason: 'PROVIDER_REJECTED',
        });
        expect(await journals(id)).toEqual({
          WITHDRAWAL_FREEZE: 1,
          WITHDRAWAL_RELEASE: 1,
        });
        expect(await money(userId)).toMatchObject({
          AVAILABLE: '5000000',
          FROZEN: '0',
          usage: '0',
        });
      });

      it('while an attempt is still in flight: no resubmit', async () => {
        const { id } = await withdrawal('PENDING');
        await expect(
          submitWith(
            new FakePayout(undefined, () => {
              throw new Error('worker died');
            }),
          ).handle(job('job.withdrawal.submit', id)),
        ).rejects.toThrow('worker died');
        await sync(id, { kind: 'NOT_FOUND' });
        const [{ n }] = await ds.query<{ n: string }[]>(
          `SELECT count(*)::text AS n FROM outbox WHERE routing_key = 'job.withdrawal.submit' AND aggregate_id = $1`,
          [id],
        );
        expect(n).toBe('1');
      });

      it('after the provider had accepted it: flagged for review, no money moves', async () => {
        const { id, userId } = await withdrawal();
        await sync(id, { kind: 'NOT_FOUND' });
        expect(await row(id)).toMatchObject({
          status: 'PROCESSING',
          needs_review: true,
          review_reason: 'UNKNOWN_AFTER_SUCCESS',
        });
        expect(await journals(id)).toEqual({ WITHDRAWAL_FREEZE: 1 });
        expect((await money(userId)).FROZEN).toBe('1500000');
      });
    });

    it('provider unreachable: nothing changes, checked again in 30 s', async () => {
      const { id } = await withdrawal();
      await sync(id, { kind: 'UNAVAILABLE', reason: 'timeout' });
      const r = await row(id);
      expect(r.status).toBe('PROCESSING');
      expect(r.check_in).toBeGreaterThanOrEqual(29);
    });

    it('a final FAILED one is still pulled when a signed webhook asks, but not changed here (W12 is X10)', async () => {
      const { id } = await withdrawal();
      await sync(id, found('FAILED'));
      const payout = await sync(id, found('SUCCEEDED'), { trigger: 'WEBHOOK' });
      expect(payout.getCalls).toBe(1);
      expect(await row(id)).toMatchObject({
        status: 'FAILED',
        provider_status: 'SUCCEEDED',
      });
      expect(await journals(id)).toEqual({
        WITHDRAWAL_FREEZE: 1,
        WITHDRAWAL_RELEASE: 1,
      });
    });

    it('stops watching for returns once the window has passed, without a GET (W15)', async () => {
      const { id } = await withdrawal();
      await sync(id, found('SUCCEEDED'));
      await ds.query(
        `UPDATE withdrawals SET completed_at = now() - interval '25 hours' WHERE id = $1`,
        [id],
      );
      const payout = await sync(id, found('RETURNED'));
      expect(payout.getCalls).toBe(0);
      expect((await row(id)).check_in).toBeNull();
    });

    it('the sweeper source turns due withdrawals into jobs: submit while PENDING, else sync; bump first', async () => {
      const pending = await withdrawal('PENDING');
      const processing = await withdrawal('PROCESSING');
      await ds.query(
        `UPDATE withdrawals SET next_check_at = now() - interval '1 second' WHERE id IN ($1, $2)`,
        [pending.id, processing.id],
      );
      const jobs = await runner.run((tx) =>
        new WithdrawalDueWork().claimDue(tx, 1000, 30),
      );
      const mine = jobs.filter((j) =>
        [pending.id, processing.id].includes(j.aggregateId),
      );
      expect(mine.map((j) => [j.aggregateId, j.job]).sort()).toEqual(
        [
          [pending.id, 'job.withdrawal.submit'],
          [processing.id, 'job.withdrawal.sync'],
        ].sort(),
      );
      expect((await row(pending.id)).check_in).toBeGreaterThan(25);
      const again = await runner.run((tx) =>
        new WithdrawalDueWork().claimDue(tx, 1000, 30),
      );
      expect(
        again.filter((j) =>
          [pending.id, processing.id].includes(j.aggregateId),
        ),
      ).toEqual([]);
    });
  },
);
