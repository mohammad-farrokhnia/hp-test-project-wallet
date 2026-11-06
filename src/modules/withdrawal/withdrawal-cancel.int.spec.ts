import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { AppError } from '../../common/errors';
import { Money } from '../../common/money';
import { AppConfig, loadConfig } from '../../config/app-config';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { TransactionRunner } from '../../database/transaction-runner';
import { newIdempotencyService } from '../idempotency/testing';
import { HttpPayoutClient } from '../integrations/payout/http-payout.client';
import type {
  LookupOutcome,
  PayoutClient,
  PayoutRequest,
  SubmitOutcome,
  TransferStatus,
} from '../integrations/payout';
import { newLedgerService } from '../ledger/testing';
import { Envelope, OutboxService } from '../messaging';
import { OutboxRepository } from '../messaging/outbox/outbox.repository';
import { InvariantsService } from '../operations/invariants/invariants.service';
import { buildPolicies } from './domain/withdrawal-policy';
import { WithdrawalSubmitHandler } from './handlers/withdrawal-submit.handler';
import { WithdrawalSyncHandler } from './handlers/withdrawal-sync.handler';
import { DailyLimitRepository } from './repositories/daily-limit.repository';
import { PayoutAttemptsRepository } from './repositories/payout-attempts.repository';
import { WithdrawalLifecycleRepository } from './repositories/withdrawal-lifecycle.repository';
import { WithdrawalsRepository } from './repositories/withdrawals.repository';
import { WithdrawalService } from './withdrawal.service';

const IBAN = 'IR330566736841214070501510';
const TRC20 = 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y79bP';

const wire = (status: number | null) => ({
  requestBody: {},
  httpStatus: status,
  responseBody: null,
  error: null,
});

/** A payout service that counts the transfers it is asked to make, and answers as scripted. */
class FakePayout implements PayoutClient {
  submits = 0;
  private readonly format = new HttpPayoutClient('http://unused', 1000);
  constructor(
    private readonly submitAs: 'accepted' | 'ambiguous' = 'accepted',
    private readonly delayMs = 0,
    private lookup: () => LookupOutcome = () => ({
      kind: 'UNAVAILABLE',
      reason: 'x',
    }),
  ) {}
  answerLookupWith(status: TransferStatus, request: PayoutRequest): void {
    this.lookup = () => ({
      kind: 'FOUND',
      snapshot: {
        requestId: request.requestId,
        trackingId: 'TRK1',
        status,
        reason: status === 'FAILED' ? 'PROVIDER_ERROR' : null,
        amount: request.amount,
        destination: request.destination,
      },
    });
  }
  requestBody(r: PayoutRequest) {
    return this.format.requestBody(r);
  }
  async submit(r: PayoutRequest): Promise<SubmitOutcome> {
    this.submits++;
    if (this.delayMs) await sleep(this.delayMs);
    if (this.submitAs === 'ambiguous') {
      return { kind: 'AMBIGUOUS', reason: 'timeout', ...wire(null) };
    }
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
  getTransfer(): Promise<LookupOutcome> {
    return Promise.resolve(this.lookup());
  }
}

describeDb(
  'POST /withdrawals/:id/cancel: only while PENDING (B6, Ambiguity #3)',
  () => {
    let ds: DataSource;
    let runner: TransactionRunner;
    let config: AppConfig;
    let service: WithdrawalService;
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

    const submitWith = (payout: PayoutClient) =>
      new WithdrawalSubmitHandler(
        runner,
        new WithdrawalsRepository(),
        new WithdrawalLifecycleRepository(),
        new PayoutAttemptsRepository(),
        outbox,
        payout,
        config,
      );
    const syncWith = (payout: PayoutClient) =>
      new WithdrawalSyncHandler(
        runner,
        new WithdrawalLifecycleRepository(),
        new PayoutAttemptsRepository(),
        new DailyLimitRepository(),
        ledger,
        outbox,
        payout,
        config,
      );
    const job = (type: string, id: string): Envelope => ({
      messageId: randomUUID(),
      type,
      aggregateType: 'WITHDRAWAL',
      aggregateId: id,
      occurredAt: new Date().toISOString(),
      payload: { withdrawalId: id },
    });

    /** A user funded with 500,000 toman (or 30 USDT) and a PENDING withdrawal of 150,000 toman (or 10 USDT). */
    async function pending(currency: 'IRR' | 'USDT' = 'IRR') {
      const usdt = currency === 'USDT';
      const userId = `b6_${randomUUID().slice(0, 12)}`;
      await runner.run((tx) =>
        ledger.creditUser(tx, {
          userId,
          amount: usdt ? Money.microUsdt(30_000_000n) : Money.toman(500_000n),
          source: 'OPS_ADJUSTMENTS',
          kind: 'ADJUSTMENT_CREDIT',
          refId: randomUUID(),
        }),
      );
      const amount = usdt
        ? Money.microUsdt(10_000_000n)
        : Money.toman(150_000n);
      const { response } = await service.request(
        {
          userId,
          amount,
          destination: usdt ? TRC20 : IBAN,
          body: { userId },
        },
        `b6-${randomUUID()}`,
      );
      const id = (response.body as { withdrawalId: string }).withdrawalId;
      const request: PayoutRequest = {
        requestId: id,
        destinationType: usdt ? 'TRC20' : 'IBAN',
        destination: usdt ? TRC20 : IBAN,
        amount,
      };
      return { id, userId, request };
    }

    const row = async (id: string) =>
      (
        await ds.query<
          {
            status: string;
            failure_reason: string | null;
            completed: boolean;
            next_check_at: Date | null;
          }[]
        >(
          `SELECT status, failure_reason, completed_at IS NOT NULL AS completed, next_check_at FROM withdrawals WHERE id = $1`,
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
    const violations = async (userId: string) =>
      (
        await new InvariantsService(runner, ledger, service).check()
      ).checks.flatMap((c) =>
        c.violations.filter((v) => Object.values(v).includes(userId)),
      );
    const key = () => `b6-cancel-${randomUUID()}`;
    const refused = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (err) {
        return err as AppError;
      }
      throw new Error('expected the cancel to be refused');
    };

    describe('cancel before anything was sent releases the funds', () => {
      it('PENDING → FAILED (CANCELLED): amount back to AVAILABLE, FROZEN empty, the daily limit given back, one RELEASE journal', async () => {
        const { id, userId } = await pending();
        expect(await money(userId)).toMatchObject({
          AVAILABLE: '3500000',
          FROZEN: '1500000',
          usage: '1500000',
        });

        const reply = await service.cancel(id, key());

        expect(reply.replayed).toBe(false);
        expect(reply.response.status).toBe(200);
        expect(reply.response.body).toMatchObject({
          withdrawalId: id,
          status: 'FAILED',
          failureReason: 'CANCELLED',
        });
        expect(await row(id)).toMatchObject({
          status: 'FAILED',
          failure_reason: 'CANCELLED',
          completed: true,
          next_check_at: null,
        });
        expect(await money(userId)).toMatchObject({
          AVAILABLE: '5000000',
          FROZEN: '0',
          DEBT: '0',
          usage: '0',
        });
        expect(await journals(id)).toEqual({
          WITHDRAWAL_FREEZE: 1,
          WITHDRAWAL_RELEASE: 1,
        });
        expect(await violations(userId)).toEqual([]);
      });

      it('a USDT withdrawal gets its fee back too: all 11 USDT, and the rated limit share', async () => {
        const { id, userId } = await pending('USDT');
        expect((await money(userId, 'USDT')).FROZEN).toBe('11000000');

        await service.cancel(id, key());

        expect(await money(userId, 'USDT')).toMatchObject({
          AVAILABLE: '30000000',
          FROZEN: '0',
          usage: '0',
        });
      });

      it('the cancelled withdrawal can be funded and withdrawn again from the freed balance', async () => {
        const { id, userId } = await pending();
        await service.cancel(id, key());
        const again = await service.request(
          {
            userId,
            amount: Money.toman(500_000n),
            destination: IBAN,
            body: { again: true },
          },
          `b6-${randomUUID()}`,
        );
        expect(again.response.status).toBe(201);
      });
    });

    describe('cancel once the worker has claimed it is 409 CANCEL_NOT_ALLOWED, and changes nothing', () => {
      const untouched = async (id: string, userId: string, status: string) => {
        const before = { row: await row(id), money: await money(userId) };
        const journalsBefore = await journals(id);
        return async () => {
          const err = await refused(service.cancel(id, key()));
          expect(err.code).toBe('CANCEL_NOT_ALLOWED');
          expect(err.status).toBe(409);
          expect(await row(id)).toEqual(before.row);
          expect((await row(id)).status).toBe(status);
          expect(await money(userId)).toEqual(before.money);
          expect(await journals(id)).toEqual(journalsBefore);
        };
      };

      it('SUBMITTING: the provider may already have the transfer', async () => {
        const { id, userId } = await pending();
        await submitWith(new FakePayout('ambiguous')).handle(
          job('job.withdrawal.submit', id),
        );
        expect((await row(id)).status).toBe('SUBMITTING');
        await (
          await untouched(id, userId, 'SUBMITTING')
        )();
      });

      it('PROCESSING', async () => {
        const { id, userId } = await pending();
        await submitWith(new FakePayout()).handle(
          job('job.withdrawal.submit', id),
        );
        expect((await row(id)).status).toBe('PROCESSING');
        await (
          await untouched(id, userId, 'PROCESSING')
        )();
      });

      it('SUCCEEDED', async () => {
        const { id, userId, request } = await pending();
        const payout = new FakePayout();
        await submitWith(payout).handle(job('job.withdrawal.submit', id));
        payout.answerLookupWith('SUCCEEDED', request);
        await syncWith(payout).handle(job('job.withdrawal.sync', id));
        expect((await row(id)).status).toBe('SUCCEEDED');
        await (
          await untouched(id, userId, 'SUCCEEDED')
        )();
      });

      it('FAILED by the provider: not CANCELLED, so it cannot be cancelled either', async () => {
        const { id, userId, request } = await pending();
        const payout = new FakePayout();
        await submitWith(payout).handle(job('job.withdrawal.submit', id));
        payout.answerLookupWith('FAILED', request);
        await syncWith(payout).handle(job('job.withdrawal.sync', id));
        expect(await row(id)).toMatchObject({
          status: 'FAILED',
          failure_reason: 'PROVIDER_FAILED',
        });
        await (
          await untouched(id, userId, 'FAILED')
        )();
      });

      it('a refused cancel stores nothing: the same key can try again', async () => {
        const { id } = await pending();
        await submitWith(new FakePayout()).handle(
          job('job.withdrawal.submit', id),
        );
        const k = key();
        expect((await refused(service.cancel(id, k))).code).toBe(
          'CANCEL_NOT_ALLOWED',
        );
        expect(
          (
            await ds.query<{ n: string }[]>(
              'SELECT count(*)::text AS n FROM idempotency_keys WHERE key = $1',
              [k],
            )
          )[0].n,
        ).toBe('0');
      });
    });

    describe('unknown ids and repeats', () => {
      it('an unknown withdrawal is NOT_FOUND', async () => {
        const err = await refused(service.cancel(randomUUID(), key()));
        expect(err.code).toBe('NOT_FOUND');
      });

      it('the same key replays the first answer: still one release', async () => {
        const { id, userId } = await pending();
        const k = key();
        const first = await service.cancel(id, k);
        const again = await service.cancel(id, k);
        expect(again.replayed).toBe(true);
        expect(again.response).toEqual(first.response);
        expect(await journals(id)).toEqual({
          WITHDRAWAL_FREEZE: 1,
          WITHDRAWAL_RELEASE: 1,
        });
        expect((await money(userId)).AVAILABLE).toBe('5000000');
      });

      it('the same key for another withdrawal is not a replay: it is IDEMPOTENCY_KEY_REUSED', async () => {
        const a = await pending();
        const b = await pending();
        const k = key();
        await service.cancel(a.id, k);
        const err = await refused(service.cancel(b.id, k));
        expect(err.code).toBe('IDEMPOTENCY_KEY_REUSED');
        expect((await row(b.id)).status).toBe('PENDING');
      });

      it('cancelling an already cancelled withdrawal with a new key is the same 200: the state asked for is the state it is in', async () => {
        const { id, userId } = await pending();
        await service.cancel(id, key());
        const again = await service.cancel(id, key());
        expect(again.response.status).toBe(200);
        expect(again.response.body).toMatchObject({
          status: 'FAILED',
          failureReason: 'CANCELLED',
        });
        expect(await journals(id)).toEqual({
          WITHDRAWAL_FREEZE: 1,
          WITHDRAWAL_RELEASE: 1,
        });
        expect((await money(userId)).AVAILABLE).toBe('5000000');
      });
    });

    describe('a cancelled withdrawal is never sent', () => {
      it('the submit job that was queued with the request finds it FAILED and does nothing', async () => {
        const { id } = await pending();
        await service.cancel(id, key());
        const payout = new FakePayout();

        await submitWith(payout).handle(job('job.withdrawal.submit', id));

        expect(payout.submits).toBe(0);
        expect((await row(id)).status).toBe('FAILED');
      });

      it('a sync for it changes nothing either', async () => {
        const { id, userId, request } = await pending();
        await service.cancel(id, key());
        const payout = new FakePayout();
        payout.answerLookupWith('SUCCEEDED', request);
        await syncWith(payout).handle({
          ...job('job.withdrawal.sync', id),
          payload: { withdrawalId: id },
        });
        expect((await row(id)).status).toBe('FAILED');
        expect(await journals(id)).toEqual({
          WITHDRAWAL_FREEZE: 1,
          WITHDRAWAL_RELEASE: 1,
        });
        expect((await money(userId)).AVAILABLE).toBe('5000000');
      });
    });

    describe('races', () => {
      it('ten different keys cancelling one withdrawal at once: all 200, the money released exactly once', async () => {
        const { id, userId } = await pending();
        const replies = await Promise.all(
          Array.from({ length: 10 }, () => service.cancel(id, key())),
        );
        expect(replies.every((r) => r.response.status === 200)).toBe(true);
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

      it('one key sent ten times at once releases once', async () => {
        const { id } = await pending();
        const k = key();
        const replies = await Promise.all(
          Array.from({ length: 10 }, () => service.cancel(id, k)),
        );
        expect(replies.filter((r) => !r.replayed)).toHaveLength(1);
        expect((await journals(id)).WITHDRAWAL_RELEASE).toBe(1);
      });

      it('cancel against the submit job, 30 times: exactly one of them wins, and the money always agrees with what was sent', async () => {
        const outcomes = { cancelled: 0, sent: 0 };
        for (let i = 0; i < 30; i++) {
          const { id, userId } = await pending();
          const payout = new FakePayout('accepted', i % 3);
          const [cancel] = await Promise.allSettled([
            service.cancel(id, key()),
            submitWith(payout).handle(job('job.withdrawal.submit', id)),
          ]);
          const w = await row(id);
          if (cancel.status === 'fulfilled') {
            outcomes.cancelled++;
            expect(payout.submits).toBe(0);
            expect(w.status).toBe('FAILED');
            expect(w.failure_reason).toBe('CANCELLED');
            expect(await money(userId)).toMatchObject({
              AVAILABLE: '5000000',
              FROZEN: '0',
            });
          } else {
            outcomes.sent++;
            expect((cancel.reason as AppError).code).toBe('CANCEL_NOT_ALLOWED');
            expect(payout.submits).toBe(1);
            expect(w.status).toBe('PROCESSING');
            expect((await journals(id)).WITHDRAWAL_RELEASE).toBeUndefined();
            expect((await money(userId)).FROZEN).toBe('1500000');
          }
          expect(await violations(userId)).toEqual([]);
        }
        expect(outcomes.cancelled + outcomes.sent).toBe(30);
      }, 60_000);

      it('a cancel that arrives while the submit has the row locked waits for it and is then refused, never lost or doubled', async () => {
        const { id, userId } = await pending();
        const payout = new FakePayout('accepted', 300);
        const submitting = submitWith(payout).handle(
          job('job.withdrawal.submit', id),
        );
        await sleep(100);
        const err = await refused(service.cancel(id, key()));
        await submitting;
        expect(err.code).toBe('CANCEL_NOT_ALLOWED');
        expect(payout.submits).toBe(1);
        expect((await money(userId)).FROZEN).toBe('1500000');
      });
    });
  },
);
