import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { Tx, TransactionRunner } from '../../../database/transaction-runner';
import {
  PAYOUT_CLIENT,
  type LookupOutcome,
  type PayoutClient,
} from '../../integrations/payout';
import { clawbackLines, LedgerService } from '../../ledger';
import {
  Envelope,
  JOBS_EXCHANGE,
  JobHandler,
  OutboxService,
} from '../../messaging';
import {
  decideSync,
  Lookup,
  SyncJournal,
} from '../domain/withdrawal-state-machine';
import { DailyLimitRepository } from '../repositories/daily-limit.repository';
import { PayoutAttemptsRepository } from '../repositories/payout-attempts.repository';
import { WithdrawalLifecycleRepository } from '../repositories/withdrawal-lifecycle.repository';
import type { SyncRow } from '../repositories/withdrawals.repository';
import { WEBHOOK_TRIGGER } from '../webhook/payout-webhook.service';
import { RESUBMIT_AFTER_NOT_FOUND } from './withdrawal-submit.handler';

const HOUR_MS = 3_600_000;

/**
 * @class WithdrawalSyncHandler
 * @description Consumer of `job.withdrawal.sync`: pull the truth with a GET, then move the withdrawal forward only.
 * 1. Without a lock, decide whether to pull: a non-final withdrawal, a SUCCEEDED one inside the return watch,
 * or any withdrawal when a signed webhook asked.
 * 2. `PayoutClient.getTransfer`, outside any transaction.
 * 3. One transaction: lock the row, decide on the state AS LOCKED (`decideSync`),
 * apply with compare-and-set, book the journals, release the daily limit, or queue a resubmit.
 * Exactly one terminal journal per withdrawal, however statuses arrive: the decision is forward-only,
 * the status change is compare-and-set under the row lock, and the ledger refuses a second SETTLE/RELEASE (`UNIQUE (kind, ref)`, `journals_withdrawal_final_key`).
 */
@Injectable()
export class WithdrawalSyncHandler implements JobHandler {
  readonly job = 'job.withdrawal.sync';
  private readonly logger = new Logger(WithdrawalSyncHandler.name);

  constructor(
    private readonly runner: TransactionRunner,
    private readonly lifecycle: WithdrawalLifecycleRepository,
    private readonly attempts: PayoutAttemptsRepository,
    private readonly limits: DailyLimitRepository,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    @Inject(PAYOUT_CLIENT) private readonly payout: PayoutClient,
    private readonly config: AppConfig,
  ) {}

  async handle(envelope: Envelope): Promise<void> {
    const id = envelope.payload.withdrawalId ?? envelope.aggregateId;
    const byWebhook = envelope.payload.trigger === WEBHOOK_TRIGGER;
    const w = await this.runner.run(
      (tx) => this.lifecycle.findForSync(tx, id),
      {
        readOnly: true,
      },
    );
    if (!w) return;

    const open = w.status !== 'SUCCEEDED' && w.status !== 'FAILED';
    const watching =
      w.status === 'SUCCEEDED' &&
      !w.returned &&
      w.completedAt !== null &&
      Date.now() - w.completedAt.getTime() <
        this.config.timing.withdrawalReturnWatchHours * HOUR_MS;
    if (!open && !watching && !byWebhook) {
      await this.runner.run((tx) =>
        this.lifecycle.applySync(tx, id, w.status, { nextCheckSeconds: null }),
      );
      return;
    }

    const lookup = toLookup(await this.payout.getTransfer(id));
    await this.runner.run((tx) => this.apply(tx, id, lookup));
  }

  /** Step 3, under the row lock. */
  private async apply(tx: Tx, id: string, lookup: Lookup): Promise<void> {
    const w = await this.lifecycle.lockForSync(tx, id);
    if (!w) return;
    const decision = decideSync(
      {
        status: w.status,
        returned: w.returned,
        attemptInFlight: await this.attempts.inFlight(
          tx,
          id,
          this.config.timing.withdrawalSubmitLeaseSeconds,
        ),
        lastAttemptRejected:
          (await this.attempts.lastOutcome(tx, id)) === 'REJECTED',
      },
      lookup,
    );

    const applied = await this.lifecycle.applySync(tx, id, w.status, {
      status: decision.to,
      failureReason: decision.failureReason,
      provider:
        lookup.kind === 'FOUND'
          ? {
              status: lookup.status,
              reason: lookup.reason,
              trackingId: lookup.trackingId,
            }
          : undefined,
      returnReason: decision.returnReason,
      review: decision.review,
      lateSuccess: decision.lateSuccess,
      nextCheckSeconds: decision.nextCheckSeconds,
    });
    if (!applied) return;

    for (const journal of decision.journals) await this.book(tx, w, journal);
    if (decision.releaseUsage) {
      await this.limits.release(tx, {
        userId: w.userId,
        day: w.limitDay,
        amountRial: w.limitAmountRial,
      });
    }
    if (decision.resubmit) {
      await this.outbox.add(tx, {
        exchange: JOBS_EXCHANGE,
        routingKey: 'job.withdrawal.submit',
        aggregate: { type: 'WITHDRAWAL', id },
        payload: { withdrawalId: id, after: RESUBMIT_AFTER_NOT_FOUND },
      });
    }
    if (decision.rule !== 'W7' && decision.rule !== 'IGNORED') {
      this.logger.log(
        `${id}: ${decision.rule} ${w.status} → ${decision.to ?? w.status}` +
          (decision.journals.length
            ? ` (${decision.journals.join(', ')})`
            : ''),
      );
    }
  }

  private async book(tx: Tx, w: SyncRow, journal: SyncJournal): Promise<void> {
    const currency = w.amount.currency;
    const total = w.amount.add(w.fee);
    const user = await this.ledger.ensureUserAccounts(tx, w.userId, currency);
    const description = `Withdrawal ${w.id}`;

    if (journal === 'LATE_SUCCESS') {
      const locked = await this.ledger.lockUserAccounts(tx, w.userId, currency);
      const clearing = await this.ledger.systemAccountId(
        tx,
        'PAYOUT_CLEARING',
        currency,
      );
      await this.ledger.post(tx, {
        kind: 'WITHDRAWAL_LATE_SUCCESS',
        refId: w.id,
        currency,
        description: `Late success of withdrawal ${w.id}`,
        lines: [
          { accountId: clearing, amount: w.amount },
          ...clawbackLines(
            {
              availableId: user.available,
              debtId: user.debt,
              available: locked.available,
            },
            w.amount,
          ),
        ],
      });
      this.logger.error(
        `ALERT ${w.id}: paid after it was FAILED (Ambiguity #1); ${w.amount.toString()} clawed back from ${w.userId}, review needed`,
      );
      return;
    }
    if (journal === 'RETURN') {
      await this.ledger.creditUser(tx, {
        userId: w.userId,
        amount: w.amount,
        source: 'PAYOUT_CLEARING',
        kind: 'WITHDRAWAL_RETURN',
        refId: w.id,
        description: `Return of withdrawal ${w.id}`,
      });
      return;
    }
    if (journal === 'RELEASE') {
      await this.ledger.post(tx, {
        kind: 'WITHDRAWAL_RELEASE',
        refId: w.id,
        currency,
        description,
        lines: [
          { accountId: user.frozen, amount: total.negate() },
          { accountId: user.available, amount: total },
        ],
      });
      return;
    }
    const clearing = await this.ledger.systemAccountId(
      tx,
      'PAYOUT_CLEARING',
      currency,
    );
    const feeRevenue = await this.ledger.systemAccountId(
      tx,
      'FEE_REVENUE',
      currency,
    );
    await this.ledger.post(tx, {
      kind: 'WITHDRAWAL_SETTLE',
      refId: w.id,
      currency,
      description,
      lines: [
        { accountId: user.frozen, amount: total.negate() },
        { accountId: clearing, amount: w.amount },
        ...(w.fee.isPositive()
          ? [{ accountId: feeRevenue, amount: w.fee }]
          : []),
      ],
    });
  }
}

function toLookup(o: LookupOutcome): Lookup {
  if (o.kind !== 'FOUND')
    return o.kind === 'NOT_FOUND'
      ? { kind: 'NOT_FOUND' }
      : { kind: 'UNAVAILABLE' };
  return {
    kind: 'FOUND',
    status: o.snapshot.status,
    reason: o.snapshot.reason,
    trackingId: o.snapshot.trackingId,
  };
}
