import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { CurrencyCode, Money } from '../../../common/money';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';
import type { DestinationType } from '../domain/withdrawal-policy';
import {
  inSeconds,
  SubmitRow,
  SyncRow,
  WithdrawalStatus,
} from './withdrawals.repository';

/**
 * @class WithdrawalLifecycleRepository
 * @description The statements that move a withdrawal through its states, for the submit and sync jobs.
 * Every status change is a compare-and-set on the expected status.
 */
@Injectable()
export class WithdrawalLifecycleRepository {
  /**
   * @function lockForSubmit
   * @description Locks the withdrawal for the submit job with `SKIP LOCKED` a row another worker holds is skipped, not waited for.
   * @returns what a submit needs, or `null` when unknown or locked by someone else
   */
  async lockForSubmit(tx: Tx, id: string): Promise<SubmitRow | null> {
    const r = await db(tx)
      .selectFrom('withdrawals')
      .select([
        'id',
        'status',
        'submit_attempts',
        'currency',
        'amount_minor',
        'destination_type',
        'destination',
      ])
      .where('id', '=', id)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (!r) return null;
    return {
      id: r.id,
      status: r.status as WithdrawalStatus,
      submitAttempts: r.submit_attempts,
      amount: Money.of(r.currency as CurrencyCode, BigInt(r.amount_minor)),
      destinationType: r.destination_type as DestinationType,
      destination: r.destination,
    };
  }

  /** Locks the withdrawal, waiting if needed, and reads its status. */
  async lockStatus(tx: Tx, id: string): Promise<WithdrawalStatus | null> {
    const r = await db(tx)
      .selectFrom('withdrawals')
      .select('status')
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return r ? (r.status as WithdrawalStatus) : null;
  }

  async startSubmitting(
    tx: Tx,
    id: string,
    attemptNo: number,
    leaseSeconds: number,
  ): Promise<void> {
    await db(tx)
      .updateTable('withdrawals')
      .set({
        status: 'SUBMITTING',
        submit_attempts: attemptNo,
        submitted_at: sql<Date>`coalesce(submitted_at, now())`,
        next_check_at: inSeconds(leaseSeconds),
      })
      .where('id', '=', id)
      .where('status', 'in', ['PENDING', 'SUBMITTING'])
      .execute();
  }

  async markProcessing(
    tx: Tx,
    id: string,
    provider: { status: string; trackingId: string | null },
    nextCheckSeconds: number,
  ): Promise<void> {
    await db(tx)
      .updateTable('withdrawals')
      .set({
        status: 'PROCESSING',
        provider_status: provider.status,
        provider_tracking_id: provider.trackingId,
        next_check_at: inSeconds(nextCheckSeconds),
      })
      .where('id', '=', id)
      .where('status', '=', 'SUBMITTING')
      .execute();
  }

  async flagReplayMismatch(
    tx: Tx,
    id: string,
    nextCheckSeconds: number,
  ): Promise<void> {
    await db(tx)
      .updateTable('withdrawals')
      .set({
        needs_review: true,
        review_reason: 'REPLAY_MISMATCH',
        next_check_at: inSeconds(nextCheckSeconds),
      })
      .where('id', '=', id)
      .where('status', '=', 'SUBMITTING')
      .execute();
  }

  /** What the sync needs to decide whether to pull at all; no lock. */
  async findForSync(
    tx: Tx,
    id: string,
  ): Promise<{
    status: WithdrawalStatus;
    returned: boolean;
    completedAt: Date | null;
  } | null> {
    const r = await db(tx)
      .selectFrom('withdrawals')
      .select(['status', 'returned_at', 'completed_at'])
      .where('id', '=', id)
      .executeTakeFirst();
    return r
      ? {
          status: r.status as WithdrawalStatus,
          returned: r.returned_at !== null,
          completedAt: r.completed_at,
        }
      : null;
  }

  /** The withdrawal under its row lock, waiting if needed: the state a sync decision is made on. */
  async lockForSync(tx: Tx, id: string): Promise<SyncRow | null> {
    const r = await db(tx)
      .selectFrom('withdrawals')
      .select([
        'id',
        'user_id',
        'status',
        'returned_at',
        'currency',
        'amount_minor',
        'fee_minor',
        'limit_day',
        'limit_amount_rial',
        'submitted_at',
        'created_at',
      ])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!r) return null;
    const currency = r.currency as CurrencyCode;
    return {
      id: r.id,
      userId: r.user_id,
      status: r.status as WithdrawalStatus,
      returned: r.returned_at !== null,
      amount: Money.of(currency, BigInt(r.amount_minor)),
      fee: Money.of(currency, BigInt(r.fee_minor)),
      limitDay: r.limit_day,
      limitAmountRial: BigInt(r.limit_amount_rial),
      openSince: r.submitted_at ?? r.created_at,
    };
  }

  /**
   * @function applySync
   * @description Applies a sync decision with compare-and-set: only while the status is still `expected`.
   * Zero rows means someone else moved it first.
   * @returns true when applied
   */
  async applySync(
    tx: Tx,
    id: string,
    expected: WithdrawalStatus,
    u: {
      status?: WithdrawalStatus;
      failureReason?: string;
      provider?: {
        status: string;
        reason: string | null;
        trackingId: string | null;
      };
      returnReason?: string | null;
      review?: string;
      lateSuccess?: boolean;
      nextCheckSeconds: number | null;
    },
  ): Promise<boolean> {
    const final = u.status === 'SUCCEEDED' || u.status === 'FAILED';
    const res = await db(tx)
      .updateTable('withdrawals')
      .set({
        ...(u.status ? { status: u.status } : {}),
        ...(u.failureReason ? { failure_reason: u.failureReason } : {}),
        ...(final
          ? { completed_at: sql<Date>`coalesce(completed_at, now())` }
          : {}),
        ...(u.lateSuccess
          ? { late_success_at: sql<Date>`now()`, failure_reason: null }
          : {}),
        ...(u.provider
          ? {
              provider_status: u.provider.status,
              provider_reason: u.provider.reason,
              provider_tracking_id: sql<string>`coalesce(${u.provider.trackingId}, provider_tracking_id)`,
            }
          : {}),
        ...(u.returnReason !== undefined
          ? { returned_at: sql<Date>`now()`, return_reason: u.returnReason }
          : {}),
        ...(u.review ? { needs_review: true, review_reason: u.review } : {}),
        next_check_at:
          u.nextCheckSeconds === null ? null : inSeconds(u.nextCheckSeconds),
      })
      .where('id', '=', id)
      .where('status', '=', expected)
      .executeTakeFirst();
    return res.numUpdatedRows === 1n;
  }
}
