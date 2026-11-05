import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { Money } from '../../../common/money';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';
import type { PspStatus } from '../../integrations/psp';
import type {
  DepositFailureReason,
  DepositReviewReason,
  DepositStatus,
} from './deposits.repository';

/** A deposit as the sync job needs it. */
export interface SyncRow {
  readonly id: string;
  readonly userId: string;
  readonly status: DepositStatus;
  readonly amount: Money;
  readonly pspToken: string | null;
  readonly checkAttempts: number;
  readonly createdAt: Date;
}

/** What one sync changes. Fields left out are not touched. */
export interface SyncUpdate {
  readonly status?: 'SUCCEEDED' | 'FAILED';
  readonly failureReason?: DepositFailureReason;
  readonly credited?: { readonly amount: Money; readonly refId: string };
  readonly pspStatus?: PspStatus;
  readonly review?: DepositReviewReason;
  readonly paidSeen: boolean;
  readonly nextCheckSeconds: number | null;
}

const COLUMNS = [
  'id',
  'user_id',
  'status',
  'amount_rial',
  'psp_token',
  'check_attempts',
  'created_at',
] as const;

/**
 * @class DepositLifecycleRepository
 * @description The statements the deposit sync uses to move a `PENDING` deposit forward.
 * Every status change is a compare-and-set on `PENDING`.
 */
@Injectable()
export class DepositLifecycleRepository {
  async findForSync(tx: Tx, id: string): Promise<SyncRow | null> {
    const r = await db(tx)
      .selectFrom('deposits')
      .select(COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? toRow(r) : null;
  }

  async lockForSync(tx: Tx, id: string): Promise<SyncRow | null> {
    const r = await db(tx)
      .selectFrom('deposits')
      .select(COLUMNS)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return r ? toRow(r) : null;
  }

  /**
   * @function applySync
   * @description Applies a sync decision only while the deposit is still `PENDING`. Counts the check.
   * `psp_ref_id` is unique: a second deposit given the same bank reference fails here instead of being credited again.
   * @returns true when applied
   */
  async applySync(tx: Tx, id: string, u: SyncUpdate): Promise<boolean> {
    const res = await db(tx)
      .updateTable('deposits')
      .set({
        ...(u.status
          ? { status: u.status, completed_at: sql<Date>`now()` }
          : {}),
        ...(u.failureReason ? { failure_reason: u.failureReason } : {}),
        ...(u.credited
          ? {
              credited_rial: u.credited.amount.minor,
              psp_ref_id: u.credited.refId,
            }
          : {}),
        ...(u.pspStatus ? { psp_status: u.pspStatus } : {}),
        ...(u.review ? { needs_review: true, review_reason: u.review } : {}),
        ...(u.paidSeen
          ? { paid_seen_at: sql<Date>`coalesce(paid_seen_at, now())` }
          : {}),
        check_attempts: sql<number>`check_attempts + 1`,
        next_check_at:
          u.nextCheckSeconds === null
            ? null
            : sql<Date>`now() + make_interval(secs => ${u.nextCheckSeconds})`,
      })
      .where('id', '=', id)
      .where('status', '=', 'PENDING')
      .executeTakeFirst();
    return res.numUpdatedRows === 1n;
  }
}

function toRow(r: {
  id: string;
  user_id: string;
  status: string;
  amount_rial: string | number | bigint;
  psp_token: string | null;
  check_attempts: number;
  created_at: Date;
}): SyncRow {
  return {
    id: r.id,
    userId: r.user_id,
    status: r.status as DepositStatus,
    amount: Money.rial(BigInt(r.amount_rial)),
    pspToken: r.psp_token,
    checkAttempts: r.check_attempts,
    createdAt: r.created_at,
  };
}
