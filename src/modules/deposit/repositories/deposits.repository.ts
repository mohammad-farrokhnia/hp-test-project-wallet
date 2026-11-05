import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Money } from '../../../common/money';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';

export type DepositStatus = 'CREATED' | 'PENDING' | 'SUCCEEDED' | 'FAILED';

export type DepositFailureReason =
  | 'PSP_REJECTED'
  | 'PSP_FAILED'
  | 'PSP_REVERSED'
  | 'EXPIRED'
  | 'CREATE_ABANDONED';

export interface NewDeposit {
  readonly id: string;
  readonly userId: string;
  readonly amount: Money;
  readonly expiresInMinutes: number;
}

export interface DepositRecord {
  readonly id: string;
  readonly userId: string;
  readonly status: DepositStatus;
  readonly amount: Money;
  readonly creditedAmount: Money | null;
  readonly paymentUrl: string | null;
  readonly failureReason: DepositFailureReason | null;
  readonly needsReview: boolean;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * @class DepositsRepository
 * @description Explicit SQL over `deposits`. Owned by the deposit module.
 * Every status change is a compare-and-set (`WHERE status = $expected`): zero rows updated means someone else already moved the deposit.
 */
@Injectable()
export class DepositsRepository {
  /**
   * @function insertCreated
   * @description Inserts a `CREATED` deposit; `expires_at` comes from the database clock.
   */
  async insertCreated(tx: Tx, d: NewDeposit): Promise<void> {
    await db(tx)
      .insertInto('deposits')
      .values({
        id: d.id,
        user_id: d.userId,
        amount_rial: d.amount.minor,
        status: 'CREATED',
        expires_at: sql<Date>`now() + make_interval(mins => ${d.expiresInMinutes})`,
      })
      .execute();
  }

  /**
   * @function findById
   * @param lock - take the row lock, so a resume cannot race the abandoned-create sweeper
   * @returns the deposit, or `null`
   */
  async findById(
    tx: Tx,
    id: string,
    lock = false,
  ): Promise<DepositRecord | null> {
    const query = db(tx)
      .selectFrom('deposits')
      .select([
        'id',
        'user_id',
        'status',
        'amount_rial',
        'credited_rial',
        'payment_url',
        'failure_reason',
        'needs_review',
        'expires_at',
        'created_at',
        'updated_at',
      ])
      .where('id', '=', id);
    const r = await (lock ? query.forUpdate() : query).executeTakeFirst();
    if (!r) return null;
    return {
      id: r.id,
      userId: r.user_id,
      status: r.status as DepositStatus,
      amount: Money.rial(BigInt(r.amount_rial)),
      creditedAmount:
        r.credited_rial === null ? null : Money.rial(BigInt(r.credited_rial)),
      paymentUrl: r.payment_url,
      failureReason: r.failure_reason as DepositFailureReason | null,
      needsReview: r.needs_review,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * @function markPending
   * @description `CREATED → PENDING` when the PSP issued a payment: stores the token and link, `psp_status = INIT`, and schedules the first status check.
   * @returns false when the deposit was no longer `CREATED`
   */
  async markPending(
    tx: Tx,
    id: string,
    payment: {
      token: string;
      paymentUrl: string;
      firstCheckInSeconds: number;
    },
  ): Promise<boolean> {
    const res = await db(tx)
      .updateTable('deposits')
      .set({
        status: 'PENDING',
        psp_token: payment.token,
        payment_url: payment.paymentUrl,
        psp_status: 'INIT',
        next_check_at: sql<Date>`now() + make_interval(secs => ${payment.firstCheckInSeconds})`,
      })
      .where('id', '=', id)
      .where('status', '=', 'CREATED')
      .executeTakeFirst();
    return res.numUpdatedRows === 1n;
  }

  /**
   * @function markFailedFromCreated
   * @description `CREATED → FAILED` with a reason.
   * @returns false when the deposit was no longer `CREATED`
   */
  async markFailedFromCreated(
    tx: Tx,
    id: string,
    reason: DepositFailureReason,
  ): Promise<boolean> {
    const res = await db(tx)
      .updateTable('deposits')
      .set({
        status: 'FAILED',
        failure_reason: reason,
        completed_at: sql<Date>`now()`,
        next_check_at: null,
      })
      .where('id', '=', id)
      .where('status', '=', 'CREATED')
      .executeTakeFirst();
    return res.numUpdatedRows === 1n;
  }
}
