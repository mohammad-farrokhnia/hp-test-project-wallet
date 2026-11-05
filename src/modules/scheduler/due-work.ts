import type { Tx } from '../../database/transaction-runner';
import type { JobName } from '../messaging';

/** One row that is due, as the job to queue for it. */
export interface DueJob {
  readonly job: JobName;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Ids only (ADR-2). */
  readonly payload: Readonly<Record<string, string>>;
}

/**
 * What the sweeper needs from a module whose rows carry `next_check_at` (withdrawal, deposit). The module owns the SQL;
 * the scheduler only knows this interface.
 *
 * Contract: **bump first.** In ONE statement, take up to `limit` rows with `next_check_at <= now()` (`FOR UPDATE SKIP LOCKED`, oldest first),
 * set their `next_check_at = now() + bumpSeconds`, and return them:
 *
 * So a row is queued once per bump: a parallel sweeper skips it while it is locked and finds it not due once committed.
 * If the publish is lost, the row is simply due again after the bump.
 */
export interface DueWorkSource {
  readonly name: string;
  claimDue(tx: Tx, limit: number, bumpSeconds: number): Promise<DueJob[]>;
}
