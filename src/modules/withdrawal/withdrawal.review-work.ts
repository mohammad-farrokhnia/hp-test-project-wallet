import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { AppConfig } from '../../config/app-config';
import { db } from '../../database/kysely';
import { Tx } from '../../database/transaction-runner';
import type { DueJob, DueWorkSource } from '../scheduler/due-work';

/**
 * @class WithdrawalReviewSource
 * @description The sweeper's escalation for withdrawals: a withdrawal still open after `REVIEW_AFTER_MINUTES` is flagged `needs_review = STUCK` and an alert is logged.
 * Never failed and never released for being silent: the money stays frozen, and its own checks (`next_check_at`) go on, so a late answer still settles or releases it.
 * Each row is flagged once (`SKIP LOCKED`; flagged rows leave the work queue). Queues no jobs.
 */
@Injectable()
export class WithdrawalReviewSource implements DueWorkSource {
  readonly name = 'withdrawal-review';
  private readonly logger = new Logger(WithdrawalReviewSource.name);

  constructor(private readonly config: AppConfig) {}

  async claimDue(tx: Tx, limit: number): Promise<DueJob[]> {
    const { rows } = await sql<{ id: string; status: string; minutes: number }>`
      UPDATE withdrawals w
         SET needs_review = true, review_reason = 'STUCK'
        FROM (SELECT id FROM withdrawals
               WHERE status IN ('PENDING', 'SUBMITTING', 'PROCESSING')
                 AND NOT needs_review
                 AND created_at < now() - make_interval(mins => ${this.config.timing.reviewAfterMinutes})
               ORDER BY created_at
               LIMIT ${limit}
                 FOR UPDATE SKIP LOCKED) stuck
       WHERE w.id = stuck.id
      RETURNING w.id, w.status,
                floor(extract(epoch FROM now() - w.created_at) / 60)::int AS minutes`.execute(
      db(tx),
    );
    for (const r of rows) {
      this.logger.error(
        `ALERT withdrawal ${r.id} still ${r.status} after ${r.minutes} min: flagged STUCK for review; funds stay frozen`,
      );
    }
    return [];
  }
}
