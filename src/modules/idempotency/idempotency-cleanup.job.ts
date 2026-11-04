import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { TransactionRunner } from '../../database/transaction-runner';
import { IdempotencyKeysRepository } from './repositories/idempotency-keys.repository';

/** Keys deleted per transaction: short transactions, no long lock on the table. */
export const PURGE_BATCH_SIZE = 1000;

/**
 * @class IdempotencyCleanupJob
 * @description Worker role: every `IDEMPOTENCY_CLEANUP_INTERVAL_MINUTES`, deletes keys older than `IDEMPOTENCY_RETENTION_DAYS`. After that a retry with an old key runs again as new;
 */
@Injectable()
export class IdempotencyCleanupJob
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(IdempotencyCleanupJob.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly keys: IdempotencyKeysRepository,
    private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const everyMs = this.config.idempotency.cleanupIntervalMinutes * 60_000;
    this.timer = setInterval(() => void this.run(), everyMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /**
   * @function run
   * @description One scheduled round; skipped while the previous one is still going. Errors are logged, never thrown, so the timer keeps running.
   */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const deleted = await this.purgeOlderThan(
        this.config.idempotency.retentionDays,
      );
      if (deleted > 0) {
        this.logger.log(`purged ${deleted} idempotency keys`);
      }
    } catch (err) {
      this.logger.error(
        `idempotency key purge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * @function purgeOlderThan
   * @description Deletes every key older than `days`, one batch per transaction, until a batch comes back short.
   * @param days - retention in days
   * @returns how many keys were deleted
   */
  async purgeOlderThan(days: number): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.runner.run((tx) =>
        this.keys.deleteOlderThan(tx, days, PURGE_BATCH_SIZE),
      );
      total += deleted;
      if (deleted < PURGE_BATCH_SIZE) return total;
    }
  }
}
