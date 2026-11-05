import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { CurrencyCode, Money } from '../../../common/money';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';
import type { DestinationType } from '../domain/withdrawal-policy';

export type WithdrawalStatus =
  'PENDING' | 'SUBMITTING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';

export interface NewWithdrawal {
  readonly id: string;
  readonly userId: string;
  readonly amount: Money;
  readonly fee: Money;
  readonly destinationType: DestinationType;
  readonly destination: string;
  readonly limitDay: string;
  readonly limitAmountRial: bigint;
  readonly nextCheckInSeconds: number;
}

export interface WithdrawalRecord {
  readonly id: string;
  readonly userId: string;
  readonly status: WithdrawalStatus;
  readonly amount: Money;
  readonly fee: Money;
  readonly destination: string;
  readonly failureReason: string | null;
  readonly returnedAt: Date | null;
  readonly returnReason: string | null;
  readonly needsReview: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * @class WithdrawalsRepository
 * @description Explicit SQL over `withdrawals`. Owned by the withdrawal module.
 */
@Injectable()
export class WithdrawalsRepository {
  /** Inserts a `PENDING` withdrawal. */
  async insert(tx: Tx, w: NewWithdrawal): Promise<void> {
    await db(tx)
      .insertInto('withdrawals')
      .values({
        id: w.id,
        user_id: w.userId,
        currency: w.amount.currency,
        amount_minor: w.amount.minor,
        fee_minor: w.fee.minor,
        destination_type: w.destinationType,
        destination: w.destination,
        status: 'PENDING',
        limit_day: w.limitDay,
        limit_amount_rial: w.limitAmountRial,
        next_check_at: sql<Date>`now() + make_interval(secs => ${w.nextCheckInSeconds})`,
      })
      .execute();
  }

  /** @returns the withdrawal, or `null` */
  async findById(tx: Tx, id: string): Promise<WithdrawalRecord | null> {
    const r = await db(tx)
      .selectFrom('withdrawals')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) return null;
    const currency = r.currency as CurrencyCode;
    return {
      id: r.id,
      userId: r.user_id,
      status: r.status as WithdrawalStatus,
      amount: Money.of(currency, BigInt(r.amount_minor)),
      fee: Money.of(currency, BigInt(r.fee_minor)),
      destination: r.destination,
      failureReason: r.failure_reason,
      returnedAt: r.returned_at,
      returnReason: r.return_reason,
      needsReview: r.needs_review,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * @function openTotals
   * @description Σ (amount + fee) of non-final withdrawals per user and currency: what FROZEN must hold.
   */
  async openTotals(tx: Tx): Promise<{ userId: string; amount: Money }[]> {
    const rows = await db(tx)
      .selectFrom('withdrawals')
      .select(['user_id', 'currency'])
      .select(sql<string>`sum(amount_minor + fee_minor)::text`.as('total'))
      .where('status', 'not in', ['SUCCEEDED', 'FAILED'])
      .groupBy(['user_id', 'currency'])
      .execute();
    return rows.map((r) => ({
      userId: r.user_id,
      amount: Money.of(r.currency as CurrencyCode, BigInt(r.total)),
    }));
  }
}
