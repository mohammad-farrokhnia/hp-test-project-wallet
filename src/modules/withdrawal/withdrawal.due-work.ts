import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { db } from '../../database/kysely';
import { Tx } from '../../database/transaction-runner';
import type { DueJob, DueWorkSource } from '../scheduler/due-work';

/**
 * @class WithdrawalDueWork
 * @description The sweeper's withdrawal source:
 * rows whose `next_check_at` is due become jobs, `job.withdrawal.submit` while PENDING, else `job.withdrawal.sync`.
 * Bump first, in one statement, so a row is queued once per bump. Walks the partial index `withdrawals_next_check_idx`.
 */
@Injectable()
export class WithdrawalDueWork implements DueWorkSource {
  readonly name = 'withdrawals';

  async claimDue(
    tx: Tx,
    limit: number,
    bumpSeconds: number,
  ): Promise<DueJob[]> {
    const { rows } = await sql<{ id: string; status: string }>`
      UPDATE withdrawals w
         SET next_check_at = now() + make_interval(secs => ${bumpSeconds})
        FROM (SELECT id FROM withdrawals
               WHERE next_check_at <= now()
               ORDER BY next_check_at
               LIMIT ${limit}
                 FOR UPDATE SKIP LOCKED) due
       WHERE w.id = due.id
      RETURNING w.id, w.status`.execute(db(tx));
    return rows.map((r) => ({
      job:
        r.status === 'PENDING'
          ? 'job.withdrawal.submit'
          : 'job.withdrawal.sync',
      aggregateType: 'WITHDRAWAL',
      aggregateId: r.id,
      payload: { withdrawalId: r.id },
    }));
  }
}
