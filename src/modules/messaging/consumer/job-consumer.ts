import { Logger } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';
import { setTimeout as sleep } from 'node:timers/promises';
import { Envelope, parseEnvelope } from '../envelope';
import type { Publisher } from '../rabbit/rabbit-publisher';
import type { QueueName } from '../topology';

/** Header carrying how many times this job has been tried; RabbitMQ 4 does not count nacks for us. */
export const ATTEMPT_HEADER = 'x-attempt';

export interface JobContext {
  readonly attempt: number;
}

/**
 * A job handler: does its work in its own transaction and returns once that committed. It is acked only then.
 */
export interface JobHandler {
  readonly job: QueueName;
  handle(envelope: Envelope, ctx: JobContext): Promise<void>;
}

export interface ConsumerOptions {
  readonly queue: string;
  readonly prefetch: number;
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
}

/** Hands out new plain channels; `RabbitConnection` in the app. */
export interface ChannelFactory {
  createChannel(): Promise<Channel>;
}

/** Wait before subscribing again after the channel closed. */
const RESUBSCRIBE_MS = 1000;

/** How long `stop()` waits for jobs in progress before closing anyway. */
export const STOP_GRACE_MS = 10_000;

/**
 * @class JobConsumer
 * @description Runs one handler on one queue.
 * - prefetch: at most `prefetch` unacked jobs at a time.
 * - success: ack only after the handler returned, so its transaction has committed. A worker that dies mid-handler never acked: the job comes back, and those lost deliveries count toward the queue's delivery limit.
 * - failure: RabbitMQ 4 does not count a nack with requeue toward the delivery limit, so the attempt is counted here: below `maxAttempts`, republish a copy with `x-attempt + 1` (confirmed), then ack the original; at `maxAttempts`, nack without requeue, which dead-letters it to `job.dead`.
 * - not an envelope: dead-lettered at once; no retry can fix it.
 * - the channel closed (reconnect, broker cancel): subscribe again.
 */
export class JobConsumer {
  private readonly logger: Logger;
  private channel?: Channel;
  private consumerTag?: string;
  private stopping = true;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly channels: ChannelFactory,
    private readonly publisher: Publisher,
    private readonly handler: JobHandler,
    private readonly options: ConsumerOptions,
  ) {
    this.logger = new Logger(`JobConsumer ${options.queue}`);
  }

  start(): void {
    if (!this.stopping) return;
    this.stopping = false;
    void this.subscribe();
  }

  /**
   * Stops taking jobs and waits up to `graceMs` for the ones in progress, then closes the channel.
   *  A job still running then is simply unacked: the broker redelivers it, so a stuck handler can delay a shutdown but never block it.
   */
  async stop(graceMs = STOP_GRACE_MS): Promise<void> {
    this.stopping = true;
    const ch = this.channel;
    if (ch && this.consumerTag)
      await ch.cancel(this.consumerTag).catch(() => undefined);
    const grace = new AbortController();
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      sleep(graceMs, undefined, { signal: grace.signal }).catch(
        () => undefined,
      ),
    ]);
    grace.abort();
    if (this.inFlight.size > 0) {
      this.logger.warn(
        `${this.inFlight.size} job(s) still running at shutdown; the broker will redeliver them`,
      );
    }
    await ch?.close().catch(() => undefined);
    this.channel = undefined;
  }

  private async subscribe(): Promise<void> {
    while (!this.stopping) {
      try {
        const ch = await this.channels.createChannel();
        if (this.stopping) {
          await ch.close();
          return;
        }
        ch.on('error', (err: Error) =>
          this.logger.warn(`channel error: ${err.message}`),
        );
        ch.once('close', () => {
          if (this.channel !== ch) return;
          this.channel = undefined;
          this.consumerTag = undefined;
          if (!this.stopping) {
            this.logger.warn('channel closed; subscribing again');
            void sleep(RESUBSCRIBE_MS).then(() => this.subscribe());
          }
        });
        this.channel = ch;
        await ch.prefetch(this.options.prefetch);
        const { consumerTag } = await ch.consume(
          this.options.queue,
          (msg) => this.receive(ch, msg),
          { noAck: false },
        );
        this.consumerTag = consumerTag;
        this.logger.log(`consuming (prefetch ${this.options.prefetch})`);
        return;
      } catch (err) {
        this.logger.warn(
          `subscribe failed: ${err instanceof Error ? err.message : 'unknown'}; retrying`,
        );
        await sleep(RESUBSCRIBE_MS);
      }
    }
  }

  private receive(ch: Channel, msg: ConsumeMessage | null): void {
    if (msg === null) {
      this.logger.warn('consumer cancelled by the broker; subscribing again');
      void ch.close().catch(() => undefined);
      return;
    }
    const work = this.process(ch, msg).finally(() =>
      this.inFlight.delete(work),
    );
    this.inFlight.add(work);
  }

  private async process(ch: Channel, msg: ConsumeMessage): Promise<void> {
    const envelope = parseEnvelope(msg.content);
    const id = msg.properties.messageId as string | undefined;
    if (!envelope) {
      this.logger.error(
        `message ${id ?? '?'} is not an envelope; dead-lettering`,
      );
      this.settle(() => ch.nack(msg, false, false));
      return;
    }
    const attempt = attemptOf(msg);
    const label = `${envelope.type} ${envelope.aggregateId} (message ${envelope.messageId}, attempt ${attempt})`;
    const started = Date.now();
    try {
      await this.handler.handle(envelope, { attempt });
      this.settle(() => ch.ack(msg));
      this.logger.log(`${label} done in ${Date.now() - started} ms`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      if (attempt >= this.options.maxAttempts) {
        this.logger.error(
          `${label} failed: ${reason}; dead-lettering to job.dead`,
        );
        this.settle(() => ch.nack(msg, false, false));
        return;
      }
      this.logger.warn(`${label} failed: ${reason}; retrying`);
      await this.retry(ch, msg, envelope, attempt);
    }
  }

  /** Republishes the job with the next attempt number, then acks this delivery. */
  private async retry(
    ch: Channel,
    msg: ConsumeMessage,
    envelope: Envelope,
    attempt: number,
  ): Promise<void> {
    await sleep(this.options.retryBackoffMs * attempt);
    try {
      await this.publisher.publish({
        exchange: '', // the default exchange routes by queue name
        routingKey: this.options.queue,
        messageId: envelope.messageId,
        body: envelope,
        headers: { [ATTEMPT_HEADER]: attempt + 1 },
      });
    } catch (err) {
      this.logger.warn(
        `retry of ${envelope.messageId} not published (${err instanceof Error ? err.message : 'unknown'}); requeueing`,
      );
      this.settle(() => ch.nack(msg, false, true));
      return;
    }
    this.settle(() => ch.ack(msg));
  }

  /** Ack or nack; on a channel that already closed the broker redelivers anyway. */
  private settle(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logger.warn(
        `could not settle: ${err instanceof Error ? err.message : 'unknown'}; the broker will redeliver`,
      );
    }
  }
}

function attemptOf(msg: ConsumeMessage): number {
  const raw: unknown = msg.properties.headers?.[ATTEMPT_HEADER];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 1;
}
