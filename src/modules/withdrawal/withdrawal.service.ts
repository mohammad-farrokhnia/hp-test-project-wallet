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
import { DailyLimitRepository } from './repositories/daily-limit.repository';
import {
  WithdrawalRecord,
  WithdrawalsRepository,
} from './repositories/withdrawals.repository';

export const WITHDRAWAL_POLICIES = Symbol('WITHDRAWAL_POLICIES');
export const WITHDRAWALS_SCOPE = 'POST /withdrawals';

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
   * before the transaction, not stored: 400 `INVALID_DESTINATION`, then 422 `BELOW_MINIMUM`;
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
    if (!quoted.ok) throw new AppError('BELOW_MINIMUM');

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
    if (locked.available.lt(quote.total)) {
      return { ok: false, rejection: rejection('INSUFFICIENT_FUNDS') };
    }
    const day = await tehranDay(tx);
    const reserved = await this.limits.reserve(tx, {
      userId,
      day,
      amountRial: quote.limitAmountRial,
      capRial: this.config.limits.withdrawDailyLimitRial,
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

function rejection(code: ErrorCode): StoredResponse {
  const err = new AppError(code);
  return { status: err.status, body: err.toBody() };
}
