import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '../../common/errors';
import { uuidv7 } from '../../common/ids';
import { Money } from '../../common/money';
import { TehranDay, tehranDay } from '../../common/time';
import { AppConfig } from '../../config/app-config';
import { Tx, TransactionRunner } from '../../database/transaction-runner';
import { IdempotencyService, StoredResponse } from '../idempotency';
import { LedgerService, UserAccountIds } from '../ledger';
import { JOBS_EXCHANGE, OutboxService } from '../messaging';
import { parseDestination } from './domain/destination';
import { quoteWithdrawal } from './domain/withdrawal-policy';
import type {
  DestinationType,
  WithdrawalPolicies,
  WithdrawalQuote,
} from './domain/withdrawal-policy';
import { toWithdrawalView } from './dto/withdrawal.mapper';
import { DailyLimitRepository } from './repositories/daily-limit.repository';
import {
  CancelRow,
  WithdrawalRecord,
  WithdrawalsRepository,
} from './repositories/withdrawals.repository';

export const WITHDRAWAL_POLICIES = Symbol('WITHDRAWAL_POLICIES');
export const WITHDRAWALS_SCOPE = 'POST /withdrawals';
export const CANCEL_SCOPE = 'POST /withdrawals/:id/cancel';

export interface RequestWithdrawal {
  readonly userId: string;
  readonly amount: Money;
  readonly destination: string;
  readonly body: unknown;
}

export interface WithdrawalReply {
  readonly response: StoredResponse;
  readonly replayed: boolean;
}

/**
 * @class WithdrawalService
 * @description Withdrawal use cases.; provider calls happen later, in the worker.
 */
@Injectable()
export class WithdrawalService {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly idempotency: IdempotencyService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly withdrawals: WithdrawalsRepository,
    private readonly limits: DailyLimitRepository,
    @Inject(WITHDRAWAL_POLICIES) private readonly policies: WithdrawalPolicies,
    private readonly config: AppConfig,
  ) {}

  /**
   * @function request
   * @description `POST /withdrawals`. Error precedence:
   * before the transaction, not stored: 400 `INVALID_DESTINATION`, then 422 `BELOW_MINIMUM` (or 400 `VALIDATION_ERROR` for an amount whose total cannot be held);
   * then one transaction, in lock order (key → accounts by id → daily usage):
   * 1. claim the key (a repeat replays; another body is 422 `IDEMPOTENCY_KEY_REUSED`);
   * 2. lock the user's accounts; available < amount + fee → stored 422 `INSUFFICIENT_FUNDS`;
   * 3. reserve the daily limit → stored 422 `DAILY_LIMIT_EXCEEDED`;
   * 4. insert the `PENDING` withdrawal, the FREEZE journal and the outbox submit job, store the 201, commit.
   * A stored 422 commits only the key, so a repeat gets the same answer; nothing is frozen or reserved.
   * @param cmd - the parsed request
   * @param key - the Idempotency-Key
   * @returns the response, fresh or replayed
   * @throws {AppError} `INVALID_DESTINATION`, `BELOW_MINIMUM`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`
   */
  async request(cmd: RequestWithdrawal, key: string): Promise<WithdrawalReply> {
    const policy = this.policies[cmd.amount.currency];
    const destination = parseDestination(
      policy.destinationType,
      cmd.destination,
    );
    if (destination === null) throw new AppError('INVALID_DESTINATION');
    const quoted = quoteWithdrawal(policy, cmd.amount);
    if (!quoted.ok) {
      throw quoted.reason === 'TOO_LARGE'
        ? new AppError('VALIDATION_ERROR', 'amount is too large')
        : new AppError('BELOW_MINIMUM');
    }

    return this.runner.run(async (tx) => {
      const claim = await this.idempotency.claim(tx, {
        key,
        scope: WITHDRAWALS_SCOPE,
        body: cmd.body,
      });
      if (claim.kind === 'REPLAY') {
        return { response: claim.response, replayed: true };
      }
      const checked = await this.checkFundsAndLimit(
        tx,
        cmd.userId,
        quoted.quote,
      );
      if (!checked.ok) return this.reply(tx, key, checked.rejection);

      const id = uuidv7();
      await this.freeze(tx, {
        id,
        userId: cmd.userId,
        quote: quoted.quote,
        destination,
        destinationType: policy.destinationType,
        ...checked,
      });
      return this.reply(
        tx,
        key,
        {
          status: 201,
          body: { withdrawalId: id, status: 'PENDING' },
        },
        id,
      );
    });
  }

  /**
   * @function cancel
   * @description `POST /withdrawals/:id/cancel`: a withdrawal can be cancelled only while `PENDING`, before any attempt to pay it.
   * Once the worker has claimed it (`SUBMITTING`) the provider may already have the transfer, so cancelling would free money that could still be paid:
   * from then on it is 409 `CANCEL_NOT_ALLOWED` and only the provider's own answer settles or releases it (ADR-3).
   * One transaction, in lock order (key → withdrawal row → accounts → daily usage):
   * 1. claim the Idempotency-Key (a repeat replays the stored answer);
   * 2. lock the withdrawal row and wait for it: a submit in progress finishes first and the cancel then sees `SUBMITTING`;
   * 3. `PENDING` → `FAILED (CANCELLED)` by compare-and-set, the `WITHDRAWAL_RELEASE` journal (amount + fee back to AVAILABLE), the day's limit given back;
   * 4. already cancelled → the same 200 (the state asked for is the state it is in); any other state → 409, nothing stored, nothing changed.
   * A submit job for a cancelled withdrawal finds it `FAILED` and does nothing.
   * @param id - the withdrawal id
   * @param key - the Idempotency-Key
   * @returns the withdrawal as it is now, fresh or replayed
   * @throws {AppError} `NOT_FOUND`, `CANCEL_NOT_ALLOWED`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`
   */
  async cancel(id: string, key: string): Promise<WithdrawalReply> {
    return this.runner.run(async (tx) => {
      const claim = await this.idempotency.claim(tx, {
        key,
        scope: CANCEL_SCOPE,
        body: { withdrawalId: id },
      });
      if (claim.kind === 'REPLAY') {
        return { response: claim.response, replayed: true };
      }
      const w = await this.withdrawals.lockForCancel(tx, id);
      if (!w) throw new AppError('NOT_FOUND', 'Withdrawal not found');

      const already = w.status === 'FAILED' && w.failureReason === 'CANCELLED';
      if (!already) {
        if (w.status !== 'PENDING') {
          throw new AppError(
            'CANCEL_NOT_ALLOWED',
            `A ${w.status} withdrawal can no longer be cancelled`,
          );
        }
        if (!(await this.withdrawals.cancelIfPending(tx, id))) {
          throw new AppError('CANCEL_NOT_ALLOWED');
        }
        await this.release(tx, w);
      }
      const record = await this.withdrawals.findById(tx, id);
      if (!record) throw new Error(`withdrawal ${id} vanished`);
      return this.reply(
        tx,
        key,
        { status: 200, body: toWithdrawalView(record) },
        id,
      );
    });
  }

  /** The money of a cancelled withdrawal goes back: amount + fee FROZEN → AVAILABLE, and the day's limit share is released. */
  private async release(tx: Tx, w: CancelRow): Promise<void> {
    const user = await this.ledger.ensureUserAccounts(
      tx,
      w.userId,
      w.amount.currency,
    );
    const total = w.amount.add(w.fee);
    await this.ledger.post(tx, {
      kind: 'WITHDRAWAL_RELEASE',
      refId: w.id,
      currency: w.amount.currency,
      description: `Cancelled withdrawal ${w.id}`,
      lines: [
        { accountId: user.frozen, amount: total.negate() },
        { accountId: user.available, amount: total },
      ],
    });
    await this.limits.release(tx, {
      userId: w.userId,
      day: w.limitDay,
      amountRial: w.limitAmountRial,
    });
  }

  /**
   * @function get
   * @returns the withdrawal, or `null` when unknown
   */
  get(id: string): Promise<WithdrawalRecord | null> {
    return this.runner.run((tx) => this.withdrawals.findById(tx, id), {
      readOnly: true,
    });
  }

  /**
   * @function openTotals
   * @description Σ (amount + fee) of non-final withdrawals per user and currency;
   * operations compares it with FROZEN (`OpenWithdrawalTotals`).
   */
  openTotals(tx: Tx): Promise<{ userId: string; amount: Money }[]> {
    return this.withdrawals.openTotals(tx);
  }

  /** Steps 2 and 3, under the account and usage row locks. */
  private async checkFundsAndLimit(
    tx: Tx,
    userId: string,
    quote: WithdrawalQuote,
  ): Promise<
    | { ok: true; accounts: UserAccountIds; day: TehranDay }
    | { ok: false; rejection: StoredResponse }
  > {
    const locked = await this.ledger.lockUserAccounts(
      tx,
      userId,
      quote.amount.currency,
    );
    if (locked.debt.isNegative()) {
      return {
        ok: false,
        rejection: rejection(
          'INSUFFICIENT_FUNDS',
          'Outstanding debt must be repaid before withdrawing',
        ),
      };
    }
    if (locked.available.lt(quote.total)) {
      return { ok: false, rejection: rejection('INSUFFICIENT_FUNDS') };
    }
    const cap = this.config.limits.withdrawDailyLimitRial;
    const day = await tehranDay(tx);
    const reserved = await this.limits.reserve(tx, {
      userId,
      day,
      amountRial: bigMin(quote.limitAmountRial, cap + 1n),
      capRial: cap,
    });
    if (!reserved)
      return { ok: false, rejection: rejection('DAILY_LIMIT_EXCEEDED') };
    return { ok: true, accounts: locked.ids, day };
  }

  /** Step 4: the withdrawal, its FREEZE journal and its submit job. */
  private async freeze(
    tx: Tx,
    w: {
      id: string;
      userId: string;
      quote: WithdrawalQuote;
      destination: string;
      destinationType: DestinationType;
      accounts: UserAccountIds;
      day: TehranDay;
    },
  ): Promise<void> {
    const { id, quote, accounts } = w;
    await this.withdrawals.insert(tx, {
      id,
      userId: w.userId,
      amount: quote.amount,
      fee: quote.fee,
      destinationType: w.destinationType,
      destination: w.destination,
      limitDay: w.day,
      limitAmountRial: quote.limitAmountRial,
      limitRateRialPerUsdt: quote.limitRateRialPerUsdt,
      nextCheckInSeconds: this.config.timing.withdrawalSafetyNetSeconds,
    });
    await this.ledger.post(tx, {
      kind: 'WITHDRAWAL_FREEZE',
      refId: id,
      currency: quote.amount.currency,
      description: `Withdrawal ${id}`,
      lines: [
        { accountId: accounts.available, amount: quote.total.negate() },
        { accountId: accounts.frozen, amount: quote.total },
      ],
    });
    await this.outbox.add(tx, {
      exchange: JOBS_EXCHANGE,
      routingKey: 'job.withdrawal.submit',
      aggregate: { type: 'WITHDRAWAL', id },
      payload: { withdrawalId: id },
    });
  }

  /** Stores the response on the key and returns it (step 6). */
  private async reply(
    tx: Tx,
    key: string,
    response: StoredResponse,
    withdrawalId?: string,
  ): Promise<WithdrawalReply> {
    await this.idempotency.complete(
      tx,
      key,
      response,
      withdrawalId ? { type: 'WITHDRAWAL', id: withdrawalId } : undefined,
    );
    return { response, replayed: false };
  }
}

/** Anything above the cap is refused alike, so cap + 1 stands for it and the counter's arithmetic can never overflow. */
function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function rejection(code: ErrorCode, message?: string): StoredResponse {
  const err = new AppError(code, message);
  return { status: err.status, body: err.toBody() };
}
