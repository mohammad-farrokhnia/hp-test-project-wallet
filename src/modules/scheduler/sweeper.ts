import { Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { uuidv7 } from '../../common/ids';
import { TransactionRunner } from '../../database/transaction-runner';
import { Envelope, JOBS_EXCHANGE, Publisher } from '../messaging';
import { DueJob, DueWorkSource } from './due-work';

export interface SweeperOptions {
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly bumpSeconds: number;
  readonly now?: () => number;
}

export interface SweepResult {
  readonly due: number;
  readonly queued: number;
  readonly failed: number;
  readonly deferred: number;
}

/** Kept between the last publish and the end of the bump. */
const SAFETY_MS = 1000;

/**
 * @class Sweeper
 * @description Per source and round: bump-and-claim in one short transaction (`DueWorkSource.claimDue`), commit, then publish straight to RabbitMQ.
 *
 * Never queued twice: a publish only starts if, at its worst case, it ends before the bump does;
 * the rest are due again after it. Resumes after a RabbitMQ restart: nothing about the work lives in the broker.
 */
export class Sweeper {
  private readonly logger = new Logger(Sweeper.name);
  private readonly now: () => number;
  private readonly publishWindowMs: number;
  private stopped = true;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly publisher: Publisher,
    private readonly sources: readonly DueWorkSource[],
    private readonly options: SweeperOptions,
  ) {
    this.now = options.now ?? (() => performance.now());
    this.publishWindowMs =
      options.bumpSeconds * 1000 - SAFETY_MS - publisher.maxPublishMs();
    if (this.publishWindowMs <= 0) {
      throw new Error(
        `SWEEPER_BUMP_SECONDS (${options.bumpSeconds}) must outlast the slowest publish ` +
          `(${publisher.maxPublishMs()} ms) plus ${SAFETY_MS} ms, or a row could be queued twice`,
      );
    }
  }

  /**
   * @function runOnce
   * @description One round over every source.
   * @returns totals for the round
   */
  async runOnce(): Promise<SweepResult> {
    const total = { due: 0, queued: 0, failed: 0, deferred: 0 };
    for (const source of this.sources) {
      const r = await this.sweep(source);
      total.due += r.due;
      total.queued += r.queued;
      total.failed += r.failed;
      total.deferred += r.deferred;
    }
    return total;
  }

  private async sweep(source: DueWorkSource): Promise<SweepResult> {
    const bumpedAt = this.now();
    const jobs = await this.runner.run((tx) =>
      source.claimDue(tx, this.options.batchSize, this.options.bumpSeconds),
    );
    const lastStart = bumpedAt + this.publishWindowMs;
    let queued = 0;
    let failed = 0;
    for (const [i, job] of jobs.entries()) {
      if (this.now() > lastStart) {
        return { due: jobs.length, queued, failed, deferred: jobs.length - i };
      }
      try {
        await this.publisher.publish(toMessage(job));
        queued++;
      } catch (err) {
        failed++;
        this.logger.warn(
          `${source.name}: ${job.job} ${job.aggregateId} not queued (${err instanceof Error ? err.message : 'unknown'}); due again after the bump`,
        );
      }
    }
    if (jobs.length > 0) {
      this.logger.log(
        `${source.name}: ${queued} of ${jobs.length} due rows queued`,
      );
    }
    return { due: jobs.length, queued, failed, deferred: 0 };
  }

  /** Sweeps until `stop()`: straight on while a source returned a full batch, else every `intervalMs`. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let full = false;
      try {
        const r = await this.runOnce();
        full = r.due >= this.options.batchSize;
      } catch (err) {
        this.logger.error(
          `sweep failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
      if (!full && !this.stopped) await this.pause();
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, this.options.intervalMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}

function toMessage(job: DueJob) {
  const body: Envelope = {
    messageId: uuidv7(),
    type: job.job,
    aggregateType: job.aggregateType,
    aggregateId: job.aggregateId,
    occurredAt: new Date().toISOString(),
    payload: job.payload,
  };
  return {
    exchange: JOBS_EXCHANGE,
    routingKey: job.job,
    messageId: body.messageId,
    body,
  };
}
