import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Money } from '../../common/money';
import { AppConfig, loadConfig } from '../../config/app-config';
import {
  connectTestDb,
  describeDb,
  lockDueWork,
} from '../../database/int-testing';
import { TransactionRunner } from '../../database/transaction-runner';
import { newIdempotencyService } from '../idempotency/testing';
import { HttpPayoutClient } from '../integrations/payout/http-payout.client';
import {
  LookupOutcome,
  PayoutClient,
  PayoutRequest,
  SubmitOutcome,
  TransferStatus,
} from '../integrations/payout';
import { newLedgerService } from '../ledger/testing';
import {
  Envelope,
  OutgoingMessage,
  OutboxService,
  Publisher,
} from '../messaging';
import { OutboxRepository } from '../messaging/outbox/outbox.repository';
import { Sweeper } from '../scheduler/sweeper';
import { buildPolicies } from './domain/withdrawal-policy';
import { WithdrawalSubmitHandler } from './handlers/withdrawal-submit.handler';
import { WithdrawalSyncHandler } from './handlers/withdrawal-sync.handler';
import { DailyLimitRepository } from './repositories/daily-limit.repository';
import { PayoutAttemptsRepository } from './repositories/payout-attempts.repository';
import { WithdrawalLifecycleRepository } from './repositories/withdrawal-lifecycle.repository';
import { WithdrawalsRepository } from './repositories/withdrawals.repository';
import { WithdrawalDueWork } from './withdrawal.due-work';
import { WithdrawalReviewSource } from './withdrawal.review-work';
import { WithdrawalService } from './withdrawal.service';

const IBAN = 'IR330566736841214070501510';

class FakePayout implements PayoutClient {
  private readonly format = new HttpPayoutClient('http://unused', 1000);
  constructor(
    private readonly lookup: LookupOutcome = {
      kind: 'UNAVAILABLE',
      reason: 'x',
    },
  ) {}
  requestBody(r: PayoutRequest) {
    return this.format.requestBody(r);
  }
  submit(r: PayoutRequest): Promise<SubmitOutcome> {
    return Promise.resolve({
      kind: 'ACCEPTED',
      snapshot: {
        requestId: r.requestId,
        trackingId: 'T',
        status: 'ACCEPTED',
        reason: null,
        amount: r.amount,
        destination: r.destination,
      },
      requestBody: {},
      httpStatus: 202,
      responseBody: null,
      error: null,
    });
  }
  getTransfer() {
    return Promise.resolve(this.lookup);
  }
}

/** X9: escalation of stuck withdrawals, and the watch for returns after success. */
describeDb('withdrawal escalation and return watch (real PostgreSQL)', () => {
  let ds: DataSource;
  let unlockDueWork: (() => Promise<void>) | undefined;
  let runner: TransactionRunner;
  let config: AppConfig;
  let service: WithdrawalService;
  let review: WithdrawalReviewSource;
  const alerts: string[] = [];
  const ledger = newLedgerService();
  const outbox = new OutboxService(new OutboxRepository());

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      alerts.push(String(m));
    });
    ds = await connectTestDb();
    unlockDueWork = await lockDueWork(ds);
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 20_000,
    });
    config = loadConfig();
    review = new WithdrawalReviewSource(config);
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
  }, 180_000);

  afterAll(async () => {
    await unlockDueWork?.();
    if (ds?.isInitialized) await ds.destroy();
    jest.restoreAllMocks();
  });

  const job = (type: string, id: string): Envelope => ({
    messageId: randomUUID(),
    type,
    aggregateType: 'WITHDRAWAL',
    aggregateId: id,
    occurredAt: new Date().toISOString(),
    payload: { withdrawalId: id },
  });
  const sync = (
    id: string,
    status: TransferStatus,
    reason: string | null = null,
  ) =>
    new WithdrawalSyncHandler(
      runner,
      new WithdrawalLifecycleRepository(),
      new PayoutAttemptsRepository(),
      new DailyLimitRepository(),
      ledger,
      outbox,
      new FakePayout({
        kind: 'FOUND',
        snapshot: {
          requestId: id,
          trackingId: 'T',
          status,
          reason,
          amount: Money.rial(1n),
          destination: IBAN,
        },
      }),
      config,
    ).handle(job('job.withdrawal.sync', id));

  /** A withdrawal of 150,000 toman accepted by the provider (PROCESSING), aged `minutes`. */
  async function processing(
    minutes = 0,
  ): Promise<{ id: string; userId: string }> {
    const userId = `x9_${randomUUID().slice(0, 12)}`;
    await runner.run((tx) =>
      ledger.creditUser(tx, {
        userId,
        amount: Money.toman(500_000n),
        source: 'OPS_ADJUSTMENTS',
        kind: 'ADJUSTMENT_CREDIT',
        refId: randomUUID(),
      }),
    );
    const { response } = await service.request(
      {
        userId,
        amount: Money.toman(150_000n),
        destination: IBAN,
        body: { userId },
      },
      `x9-${randomUUID()}`,
    );
    const id = (response.body as { withdrawalId: string }).withdrawalId;
    await new WithdrawalSubmitHandler(
      runner,
      new WithdrawalsRepository(),
      new WithdrawalLifecycleRepository(),
      new PayoutAttemptsRepository(),
      outbox,
      new FakePayout(),
      config,
    ).handle(job('job.withdrawal.submit', id));
    if (minutes > 0) {
      await ds.query(
        `UPDATE withdrawals SET created_at = now() - make_interval(mins => $2) WHERE id = $1`,
        [id, minutes],
      );
    }
    return { id, userId };
  }

  const sweepReview = () => runner.run((tx) => review.claimDue(tx, 1000));
  const state = async (id: string) =>
    (
      await ds.query<
        {
          status: string;
          needs_review: boolean;
          review_reason: string | null;
          next_check_at: Date | null;
        }[]
      >(
        'SELECT status, needs_review, review_reason, next_check_at FROM withdrawals WHERE id = $1',
        [id],
      )
    )[0];
  const money = async (userId: string) =>
    Object.fromEntries(
      (
        await ds.query<{ kind: string; b: string }[]>(
          `SELECT kind, balance_minor::text AS b FROM accounts WHERE user_id = $1 AND currency = 'IRR'`,
          [userId],
        )
      ).map((r) => [r.kind, r.b]),
    );
  const alertsFor = (id: string) => alerts.filter((a) => a.includes(id));

  describe('escalation: needs_review after 30 minutes (W14)', () => {
    it('a stuck transfer is flagged STUCK with an alert, and stays frozen', async () => {
      const { id, userId } = await processing(31);
      const before = await state(id);

      expect(await sweepReview()).toEqual([]); // queues nothing
      const after = await state(id);

      expect(after).toMatchObject({
        status: 'PROCESSING',
        needs_review: true,
        review_reason: 'STUCK',
      });
      expect(after.next_check_at).toEqual(before.next_check_at); // still checked as before
      expect(await money(userId)).toEqual({
        AVAILABLE: '3500000',
        FROZEN: '1500000',
        DEBT: '0',
      });
      expect(alertsFor(id)).toEqual([
        expect.stringMatching(
          /^ALERT withdrawal .* still PROCESSING after 3[01] min: flagged STUCK/,
        ) as string,
      ]);
    });

    it('leaves alone a withdrawal younger than 30 minutes, a final one, and one already flagged', async () => {
      const young = await processing(29);
      const final = await processing(60);
      await sync(final.id, 'SUCCEEDED');
      const flagged = await processing(60);
      await ds.query(
        `UPDATE withdrawals SET needs_review = true, review_reason = 'REPLAY_MISMATCH' WHERE id = $1`,
        [flagged.id],
      );

      await sweepReview();
      expect(await state(young.id)).toMatchObject({ needs_review: false });
      expect(await state(final.id)).toMatchObject({
        status: 'SUCCEEDED',
        needs_review: false,
      });
      expect(await state(flagged.id)).toMatchObject({
        review_reason: 'REPLAY_MISMATCH',
      });
    });

    it('flags and alerts once, however many sweeps run', async () => {
      const { id } = await processing(45);
      await Promise.all([sweepReview(), sweepReview()]);
      await sweepReview();
      expect(alertsFor(id)).toHaveLength(1);
    });

    it('a flagged withdrawal is still resolved when the answer comes', async () => {
      const { id, userId } = await processing(45);
      await sweepReview();
      await sync(id, 'SUCCEEDED');
      expect(await state(id)).toMatchObject({
        status: 'SUCCEEDED',
        needs_review: true,
        review_reason: 'STUCK',
      });
      expect(await money(userId)).toMatchObject({
        FROZEN: '0',
        AVAILABLE: '3500000',
      });
    });
  });

  describe('watching succeeded transfers for returns (PAY-07, W10, W15)', () => {
    class CapturingPublisher implements Publisher {
      readonly sent: OutgoingMessage[] = [];
      publish(m: OutgoingMessage) {
        this.sent.push(m);
        return Promise.resolve();
      }
      maxPublishMs() {
        return 1000;
      }
    }
    const sweepFor = async (id: string) => {
      const publisher = new CapturingPublisher();
      await new Sweeper(runner, publisher, [new WithdrawalDueWork()], {
        intervalMs: 1000,
        batchSize: 1000,
        bumpSeconds: 30,
      }).runOnce();
      return publisher.sent
        .filter((m) => (m.body as Envelope).aggregateId === id)
        .map((m) => m.routingKey);
    };
    const makeDue = (id: string) =>
      ds.query(
        `UPDATE withdrawals SET next_check_at = now() - interval '10 years' WHERE id = $1`,
        [id],
      );

    it('a succeeded withdrawal comes due again, the sweeper queues a sync, and a return is booked', async () => {
      const { id, userId } = await processing();
      await sync(id, 'SUCCEEDED');
      const watched = await state(id);
      expect(watched.next_check_at!.getTime() - Date.now()).toBeGreaterThan(
        250_000,
      );

      await makeDue(id);
      expect(await sweepFor(id)).toEqual(['job.withdrawal.sync']);
      await sync(id, 'RETURNED', 'ACCOUNT_CLOSED');

      const [{ n }] = await ds.query<{ n: string }[]>(
        `SELECT count(*)::text AS n FROM journals WHERE ref_id = $1 AND kind = 'WITHDRAWAL_RETURN'`,
        [id],
      );
      expect(n).toBe('1');
      expect(await money(userId)).toMatchObject({
        AVAILABLE: '5000000',
        FROZEN: '0',
      });
      expect((await state(id)).next_check_at).toBeNull(); // returned: nothing left to watch
    });

    it('after the watch window, a due check stops the watch for good', async () => {
      const { id } = await processing();
      await sync(id, 'SUCCEEDED');
      await ds.query(
        `UPDATE withdrawals SET completed_at = now() - interval '25 hours', next_check_at = now() - interval '10 years' WHERE id = $1`,
        [id],
      );
      expect(await sweepFor(id)).toEqual(['job.withdrawal.sync']);
      await sync(id, 'RETURNED'); // past the window: not even asked
      expect((await state(id)).next_check_at).toBeNull();
      expect(await sweepFor(id)).toEqual([]);
    });
  });
});
