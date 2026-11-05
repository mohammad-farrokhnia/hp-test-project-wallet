import { Logger } from '@nestjs/common';
import {
  ChannelModel,
  connect,
  ConfirmChannel,
  RecoveringChannelModel,
} from 'amqplib';
import { declareTopology, Topology } from '../topology';

/** A refused connection is an AggregateError with an empty message; fall back to its code. */
function describe(err: Error): string {
  const code = (err as { code?: string }).code;
  return err.message || code || err.name;
}

/** Anything that hands out a confirm channel; the publisher depends on this, so tests can fake it. */
export interface ConfirmChannelSource {
  confirmChannel(): Promise<ConfirmChannel>;
}

/**
 * @class RabbitConnection
 * @description One reconnecting AMQP connection per worker (ADR-2). `start()` returns at once: a broker that is down delays work but never stops the worker from booting, and the connection keeps retrying with backoff. After every (re)connect the topology is declared again, so a broker that lost its state comes back complete.
 */
export class RabbitConnection implements ConfirmChannelSource {
  private readonly logger = new Logger(RabbitConnection.name);
  private model?: RecoveringChannelModel;
  private channel?: Promise<ConfirmChannel>;

  constructor(
    private readonly url: string,
    private readonly topology: Topology,
  ) {}

  /** Opens the connection in the background; safe to call once. */
  async start(): Promise<void> {
    const model = await connect(this.url, {
      recovery: {
        waitForConnect: false,
        initialDelay: 200,
        maxDelay: 30_000,
        setup: async (m: ChannelModel) => {
          const ch = await m.createChannel();
          try {
            await declareTopology(ch, this.topology);
          } finally {
            await ch.close();
          }
        },
      },
    });
    model.on('connect', () => this.logger.log('connected; topology declared'));
    model.on('disconnect', (err: Error) =>
      this.logger.warn(`disconnected: ${describe(err)}; reconnecting`),
    );
    model.on('connect-failed', (err: Error) =>
      this.logger.warn(`connect failed: ${describe(err)}`),
    );
    model.on('error', (err: Error) => this.logger.error(describe(err)));
    this.model = model;
  }

  /** Resolves once connected and the topology is declared. */
  async ready(): Promise<void> {
    await this.requireModel().waitForConnect();
  }

  /**
   * @function confirmChannel
   * @description The shared confirm channel, opened on first use and again after it closes (a reconnect closes every channel). Waits while the broker is down.
   */
  confirmChannel(): Promise<ConfirmChannel> {
    if (!this.channel) {
      const opening = this.requireModel()
        .createConfirmChannel()
        .then((ch) => {
          ch.on('error', (err: Error) =>
            this.logger.warn(`channel error: ${describe(err)}`),
          );
          ch.once('close', () => {
            if (this.channel === opening) this.channel = undefined;
          });
          return ch;
        });
      opening.catch(() => {
        if (this.channel === opening) this.channel = undefined;
      });
      this.channel = opening;
    }
    return this.channel;
  }

  async close(): Promise<void> {
    const model = this.model;
    this.model = undefined;
    this.channel = undefined;
    await model?.close();
  }

  private requireModel(): RecoveringChannelModel {
    if (!this.model) throw new Error('RabbitConnection is not started');
    return this.model;
  }
}
