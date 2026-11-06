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

export type DepositReviewReason =
  | 'AMOUNT_DIFFERS'
  | 'UNVERIFIED_TOO_LONG'
  | 'LATE_PAYMENT_AFTER_EXPIRY'
  | 'UNKNOWN_TOKEN'
  | 'DUPLICATE_REF';

/** What a callback is matched against. */
export interface CallbackTarget {
  readonly id: string;
  readonly status: DepositStatus;
  readonly pspToken: string | null;
  readonly failureReason: DepositFailureReason | null;
}

/** A deposit as the settlement reconciliation sees it: only what it compares. */
export interface BankReferenced {
  readonly id: string;
  /** The PSP's bank reference, as stored. */
  readonly bankReference: string;
  /** The same without leading zeros: the form the PSP's file is compared in. */
  readonly reference: string;
  readonly status: DepositStatus;
  readonly creditedRial: bigint | null;
  readonly completedAt: Date | null;
}

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
   * @function findCallbackTarget
   * @returns the deposit a callback names, or `null`
   */
  async findCallbackTarget(tx: Tx, id: string): Promise<CallbackTarget | null> {
    const r = await db(tx)
      .selectFrom('deposits')
      .select(['id', 'status', 'psp_token', 'failure_reason'])
      .where('id', '=', id)
      .executeTakeFirst();
    return r
      ? {
          id: r.id,
          status: r.status as DepositStatus,
          pspToken: r.psp_token,
          failureReason: r.failure_reason as DepositFailureReason | null,
        }
      : null;
  }

  /**
   * @function scheduleCheckNow
   * @description Makes a `PENDING` deposit due for a sync right away.
   * @returns false when the deposit is no longer `PENDING`
   */
  async scheduleCheckNow(tx: Tx, id: string): Promise<boolean> {
    const res = await db(tx)
      .updateTable('deposits')
      .set({ next_check_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('status', '=', 'PENDING')
      .executeTakeFirst();
    return res.numUpdatedRows === 1n;
  }

  /**
   * @function flagLatePayment
   * @description Marks a deposit that expired, and then got a callback saying it was paid, for support. It is never verified, so the gateway returns the money to the payer.
   */
  async flagLatePayment(tx: Tx, id: string): Promise<void> {
    await db(tx)
      .updateTable('deposits')
      .set({
        needs_review: true,
        review_reason:
          'LATE_PAYMENT_AFTER_EXPIRY' satisfies DepositReviewReason,
      })
      .where('id', '=', id)
      .where('status', '=', 'FAILED')
      .where('failure_reason', '=', 'EXPIRED')
      .execute();
  }

  /**
   * @function creditedOn
   * @description The deposits credited during one Tehran calendar day (by the database clock): `SUCCEEDED`, with the bank reference they were verified under.
   * @param day - `YYYY-MM-DD`
   */
  async creditedOn(tx: Tx, day: string): Promise<BankReferenced[]> {
    const { rows } = await sql<BankReferencedRow>`
      SELECT id, psp_ref_id, status, credited_rial, completed_at
        FROM deposits
       WHERE status = 'SUCCEEDED' AND psp_ref_id IS NOT NULL
         AND completed_at >= (${day}::date)::timestamp AT TIME ZONE 'Asia/Tehran'
         AND completed_at <  (${day}::date + 1)::timestamp AT TIME ZONE 'Asia/Tehran'
       ORDER BY completed_at, id`.execute(db(tx));
    return rows.map(toBankReferenced);
  }

  /**
   * @function findByBankReferences
   * @description The deposits (any status, any day) holding one of these bank references, compared without leading zeros.
   * @param references - references with no leading zeros
   */
  async findByBankReferences(
    tx: Tx,
    references: readonly string[],
  ): Promise<BankReferenced[]> {
    if (references.length === 0) return [];
    const { rows } = await sql<BankReferencedRow>`
      SELECT id, psp_ref_id, status, credited_rial, completed_at
        FROM deposits
       WHERE psp_ref_id IS NOT NULL
         AND ltrim(psp_ref_id, '0') = ANY(${[...references]}::text[])`.execute(
      db(tx),
    );
    return rows.map(toBankReferenced);
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

interface BankReferencedRow {
  id: string;
  psp_ref_id: string;
  status: string;
  credited_rial: string | null;
  completed_at: Date | null;
}

function toBankReferenced(r: BankReferencedRow): BankReferenced {
  return {
    id: r.id,
    bankReference: r.psp_ref_id,
    reference: r.psp_ref_id.replace(/^0+/, ''),
    status: r.status as DepositStatus,
    creditedRial: r.credited_rial === null ? null : BigInt(r.credited_rial),
    completedAt: r.completed_at,
  };
}
