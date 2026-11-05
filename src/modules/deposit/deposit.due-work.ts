import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { db } from '../../database/kysely';
import { Tx } from '../../database/transaction-runner';
import type { DueJob, DueWorkSource } from '../scheduler/due-work';

/**
 * @class DepositDueWork
 * @description The sweeper's deposit source, and the poller for lost callbacks:
 * a `PENDING` deposit whose `next_check_at` is due becomes a `job.deposit.sync`.
 * Bump first, in one statement, so a row is queued once per bump. Walks the partial index `deposits_next_check_idx`.
 * Each sync sets the next check by the poll schedule, so a paid payment is found within a minute.
 */
@Injectable()
export class DepositDueWork implements DueWorkSource {
  readonly name = 'deposits';

  async claimDue(
    tx: Tx,
    limit: number,
    bumpSeconds: number,
  ): Promise<DueJob[]> {
    const { rows } = await sql<{ id: string }>`
      UPDATE deposits d
         SET next_check_at = now() + make_interval(secs => ${bumpSeconds})
        FROM (SELECT id FROM deposits
               WHERE status = 'PENDING' AND next_check_at <= now()
               ORDER BY next_check_at
               LIMIT ${limit}
                 FOR UPDATE SKIP LOCKED) due
       WHERE d.id = due.id
      RETURNING d.id`.execute(db(tx));
    return rows.map((r) => ({
      job: 'job.deposit.sync',
      aggregateType: 'DEPOSIT',
      aggregateId: r.id,
      payload: { depositId: r.id },
    }));
  }
}
