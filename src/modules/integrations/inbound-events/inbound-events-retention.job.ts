import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { TransactionRunner } from '../../../database/transaction-runner';
import { InboundEvents } from './inbound-events.service';

/** Rows deleted per transaction: short transactions, no long lock on the table. */
export const INBOUND_RETENTION_BATCH_SIZE = 1000;

/**
 * @class InboundEventsRetentionJob
 * @description Worker role: every `RETENTION_INTERVAL_MINUTES`, deletes recorded callbacks and webhooks older than `INBOUND_EVENTS_RETENTION_DAYS`.
 * They are an audit trail and evidence, never an input: no state or money depends on a row being there.
 */
@Injectable()
export class InboundEventsRetentionJob
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(InboundEventsRetentionJob.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly events: InboundEvents,
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
   * @description One scheduled round; skipped while the previous one is still going. Errors are logged, never thrown, so the timer keeps running.
   */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let total = 0;
      for (;;) {
        const deleted = await this.runner.run((tx) =>
          this.events.deleteOlderThan(
            tx,
            this.config.retention.inboundEventsDays,
            INBOUND_RETENTION_BATCH_SIZE,
          ),
        );
        total += deleted;
        if (deleted < INBOUND_RETENTION_BATCH_SIZE) break;
      }
      if (total > 0) this.logger.log(`purged ${total} inbound events`);
    } catch (err) {
      this.logger.error(
        `inbound events retention failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
