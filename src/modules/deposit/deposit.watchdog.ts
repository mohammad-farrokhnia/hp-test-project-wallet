import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { AppConfig } from '../../config/app-config';
import { db } from '../../database/kysely';
import { Tx } from '../../database/transaction-runner';
import type { DueJob, DueWorkSource } from '../scheduler/due-work';

/**
 * @class DepositWatchdog
 * @description The sweeper's escalation for deposits. Queues no jobs; each statement uses `SKIP LOCKED`, so a row a sync holds is left for the next round.
 * - Abandoned create: a deposit still `CREATED` after `DEPOSIT_ABANDON_AFTER_MINUTES` becomes `FAILED (CREATE_ABANDONED)`. Its token, if the PSP made one, was never shown to anyone, so it cannot be paid.
 *   The idempotency key is left as it is: a retry with it resumes, finds the failed deposit and answers from that state.
 * - Unverified too long: a `PENDING` deposit first seen paid more than `DEPOSIT_UNVERIFIED_ALERT_SECONDS` ago is flagged `needs_review = UNVERIFIED_TOO_LONG` and an alert is logged,
 *   because the gateway reverses a payment nobody verifies within minutes (PSP-10). It is never failed: its checks go on, so a late verify still credits it.
 */
@Injectable()
export class DepositWatchdog implements DueWorkSource {
  readonly name = 'deposit-watchdog';
  private readonly logger = new Logger(DepositWatchdog.name);

  constructor(private readonly config: AppConfig) {}

  async claimDue(tx: Tx, limit: number): Promise<DueJob[]> {
    await this.abandonStaleCreates(tx, limit);
    await this.flagUnverified(tx, limit);
    return [];
  }

  private async abandonStaleCreates(tx: Tx, limit: number): Promise<void> {
    const { rows } = await sql<{ id: string; minutes: number }>`
      UPDATE deposits d
         SET status = 'FAILED', failure_reason = 'CREATE_ABANDONED',
             completed_at = now(), next_check_at = NULL
        FROM (SELECT id FROM deposits
               WHERE status = 'CREATED'
                 AND created_at < now() - make_interval(mins => ${this.config.timing.depositAbandonAfterMinutes})
               ORDER BY created_at
               LIMIT ${limit}
                 FOR UPDATE SKIP LOCKED) stale
       WHERE d.id = stale.id
      RETURNING d.id, floor(extract(epoch FROM now() - d.created_at) / 60)::int AS minutes`.execute(
      db(tx),
    );
    for (const r of rows) {
      this.logger.warn(
        `deposit ${r.id} still CREATED after ${r.minutes} min: failed as CREATE_ABANDONED`,
      );
    }
  }

  private async flagUnverified(tx: Tx, limit: number): Promise<void> {
    const { rows } = await sql<{ id: string; seconds: number }>`
      UPDATE deposits d
         SET needs_review = true, review_reason = 'UNVERIFIED_TOO_LONG'
        FROM (SELECT id FROM deposits
               WHERE status = 'PENDING' AND NOT needs_review
                 AND paid_seen_at < now() - make_interval(secs => ${this.config.timing.depositUnverifiedAlertSeconds})
               ORDER BY paid_seen_at
               LIMIT ${limit}
                 FOR UPDATE SKIP LOCKED) stuck
       WHERE d.id = stuck.id
      RETURNING d.id, floor(extract(epoch FROM now() - d.paid_seen_at))::int AS seconds`.execute(
      db(tx),
    );
    for (const r of rows) {
      this.logger.error(
        `ALERT deposit ${r.id} seen paid ${r.seconds} s ago and still not verified: flagged UNVERIFIED_TOO_LONG; the gateway reverses unverified payments within minutes`,
      );
    }
  }
}
