import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { TransactionRunner, Tx } from '../../../database/transaction-runner';
import { InboxService } from '../inbox/inbox.service';
import { OutboxRepository } from '../outbox/outbox.repository';

/** Rows deleted per transaction: short transactions, no long lock on the table. */
export const RETENTION_BATCH_SIZE = 1000;

/**
 * @class MessagingRetentionJob
 * @description Worker role: every `RETENTION_INTERVAL_MINUTES`, deletes outbox rows PUBLISHED more than `OUTBOX_RETENTION_DAYS` ago
 * and inbox rows older than `INBOX_RETENTION_DAYS`. An unsent outbox row is never deleted, however old: it is a message not yet delivered.
 * The inbox keeps ids longer than the outbox keeps messages, so a late duplicate is still recognised.
 */
@Injectable()
export class MessagingRetentionJob
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(MessagingRetentionJob.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxRepository,
    private readonly inbox: InboxService,
    private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const everyMs = this.config.retention.intervalMinutes * 60_000;
    this.timer = setInterval(() => void this.run(), everyMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /**
   * @function run
   * @description One scheduled round; skipped while the previous one is still going.
   * Errors are logged, never thrown, so the timer keeps running.
   */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { outboxDays, inboxDays } = this.config.retention;
      const outbox = await this.purge((tx, limit) =>
        this.outbox.deletePublishedOlderThan(tx, outboxDays, limit),
      );
      const inbox = await this.purge((tx, limit) =>
        this.inbox.deleteOlderThan(tx, inboxDays, limit),
      );
      if (outbox + inbox > 0) {
        this.logger.log(
          `purged ${outbox} published outbox rows and ${inbox} inbox rows`,
        );
      }
    } catch (err) {
      this.logger.error(
        `messaging retention failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Runs `deleteBatch` one batch per transaction until a batch comes back short. */
  private async purge(
    deleteBatch: (tx: Tx, limit: number) => Promise<number>,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.runner.run((tx) =>
        deleteBatch(tx, RETENTION_BATCH_SIZE),
      );
      total += deleted;
      if (deleted < RETENTION_BATCH_SIZE) return total;
    }
  }
}
