import { Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { TransactionRunner } from '../../../database/transaction-runner';
import { Envelope } from '../envelope';
import type { OutgoingMessage, Publisher } from '../rabbit/rabbit-publisher';
import { ClaimedRow, OutboxRepository } from './outbox.repository';

export type { Publisher };

export function toEnvelope(row: ClaimedRow): OutgoingMessage {
  const body: Envelope = {
    messageId: row.id.toString(),
    type: row.routingKey,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    occurredAt: row.createdAt.toISOString(),
    payload: row.payload,
  };
  return {
    exchange: row.exchange,
    routingKey: row.routingKey,
    messageId: body.messageId,
    body,
  };
}

export interface RelayOptions {
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly claimSeconds: number;
  readonly now?: () => number;
}

export interface RoundResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
  readonly deferred: number;
}

/** Kept between the last publish and the claim's end, for marking rows sent. */
const SAFETY_MS = 1000;

/**
 * @class OutboxRelay
 * @description Moves outbox rows to RabbitMQ. One round:
 * 1. claim a batch in a short transaction (`FOR UPDATE SKIP LOCKED`, `claimed_until = now + claim`), commit;
 * 2. publish each row with confirms, outside any transaction (no network call inside one);
 * 3. mark the published rows sent, and record failures, in a second short transaction.
 *
 * Never twice: a publish only starts if it can finish, at its worst case, before the claim ends; anything left stays claimed and is taken later.
 * Never lost: a relay that dies after publishing but before marking leaves its rows claimed; when the claim expires another relay publishes them again.
 */
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly now: () => number;
  private readonly publishWindowMs: number;
  private stopped = true;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxRepository,
    private readonly publisher: Publisher,
    private readonly options: RelayOptions,
  ) {
    this.now = options.now ?? (() => performance.now());
    const claimMs = options.claimSeconds * 1000;
    this.publishWindowMs = claimMs - SAFETY_MS - publisher.maxPublishMs();
    if (this.publishWindowMs <= 0) {
      throw new Error(
        `OUTBOX_CLAIM_SECONDS (${options.claimSeconds}) must outlast the slowest publish ` +
          `(${publisher.maxPublishMs()} ms) plus ${SAFETY_MS} ms, or two relays could publish one row`,
      );
    }
  }

  /**
   * @function runOnce
   * @description One claim → publish → mark round.
   * @returns how many rows were claimed, published, failed and deferred
   */
  async runOnce(): Promise<RoundResult> {
    const claimedAt = this.now();
    const rows = await this.runner.run((tx) =>
      this.outbox.claimBatch(
        tx,
        this.options.batchSize,
        this.options.claimSeconds,
      ),
    );
    if (rows.length === 0) {
      return { claimed: 0, published: 0, failed: 0, deferred: 0 };
    }

    const lastStart = claimedAt + this.publishWindowMs;
    const published: bigint[] = [];
    const failed: { id: bigint; error: string }[] = [];
    let deferred = 0;
    for (const row of rows) {
      if (this.now() > lastStart) {
        deferred = rows.length - published.length - failed.length;
        break;
      }
      try {
        await this.publisher.publish(toEnvelope(row));
        published.push(row.id);
      } catch (err) {
        failed.push({
          id: row.id,
          error: err instanceof Error ? err.message : 'publish failed',
        });
      }
    }

    await this.runner.run(async (tx) => {
      await this.outbox.markPublished(tx, published);
      for (const f of failed) {
        await this.outbox.recordFailure(
          tx,
          f.id,
          f.error,
          this.options.claimSeconds,
        );
      }
    });
    for (const f of failed) {
      this.logger.warn(`outbox ${f.id} not published: ${f.error}`);
    }
    return {
      claimed: rows.length,
      published: published.length,
      failed: failed.length,
      deferred,
    };
  }

  /** Runs rounds until `stop()`: straight on after a full batch, after `intervalMs` otherwise. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  /** Stops after the current round; resolves once it has finished. */
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
        full = r.claimed === this.options.batchSize;
      } catch (err) {
        this.logger.error(
          `outbox relay round failed: ${err instanceof Error ? err.message : 'unknown error'}`,
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
