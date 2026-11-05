import { Logger } from '@nestjs/common';
import type { ConfirmChannel, Message } from 'amqplib';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfirmChannelSource } from './rabbit-connection';

/** One message to publish. */
export interface OutgoingMessage {
  readonly exchange: string;
  readonly routingKey: string;
  readonly messageId: string;
  readonly body: unknown;
}

export interface PublisherOptions {
  readonly timeoutMs: number;
  readonly retries: number;
  readonly backoffMs: number;
}

export class PublishError extends Error {
  constructor(
    readonly reason: 'UNROUTABLE' | 'NOT_CONFIRMED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PublishError';
  }
}

/**
 * @class RabbitPublisher
 * @description Publishes with publisher confirms (ADR-2): `publish` resolves only once the broker has taken responsibility for the message. A nack, a missing confirm or a lost channel is retried; a retry may deliver twice, which is fine, because every consumer is idempotent and the message id stays the same. Messages are persistent and `mandatory`, so one no queue would receive comes back as `UNROUTABLE` instead of vanishing.
 */
export class RabbitPublisher {
  private readonly logger = new Logger(RabbitPublisher.name);

  constructor(
    private readonly channels: ConfirmChannelSource,
    private readonly options: PublisherOptions,
  ) {}

  /**
   * @function publish
   * @throws {PublishError} `UNROUTABLE` at once; `NOT_CONFIRMED` after `retries + 1` attempts
   */
  async publish(message: OutgoingMessage): Promise<void> {
    const attempts = this.options.retries + 1;
    for (let attempt = 1; ; attempt++) {
      try {
        const ch = await this.channels.confirmChannel();
        await this.publishOnce(ch, message);
        return;
      } catch (err) {
        if (err instanceof PublishError) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        if (attempt >= attempts) {
          throw new PublishError(
            'NOT_CONFIRMED',
            `${message.messageId} not confirmed after ${attempts} attempts: ${reason}`,
            { cause: err },
          );
        }
        this.logger.warn(
          `publish ${message.messageId} attempt ${attempt} failed (${reason}); retrying`,
        );
        await sleep(this.options.backoffMs * attempt);
      }
    }
  }

  /** One attempt: resolves on ack, rejects on nack, return, timeout or channel loss. */
  private publishOnce(ch: ConfirmChannel, m: OutgoingMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      let returned = false;
      let settled = false;
      const onReturn = (msg: Message) => {
        if (msg.properties.messageId === m.messageId) returned = true;
      };
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ch.off('return', onReturn);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(
        () =>
          finish(new Error(`no confirm within ${this.options.timeoutMs} ms`)),
        this.options.timeoutMs,
      );
      ch.on('return', onReturn);
      try {
        ch.publish(
          m.exchange,
          m.routingKey,
          Buffer.from(JSON.stringify(m.body)),
          {
            persistent: true,
            mandatory: true,
            contentType: 'application/json',
            messageId: m.messageId,
            timestamp: Math.floor(Date.now() / 1000),
          },
          (err: unknown) => {
            if (err) finish(err instanceof Error ? err : new Error('nacked'));
            else if (returned) {
              finish(
                new PublishError(
                  'UNROUTABLE',
                  `${m.messageId}: no queue bound for ${m.exchange} / ${m.routingKey}`,
                ),
              );
            } else finish();
          },
        );
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}
