import { Logger } from '@nestjs/common';
import type { ConfirmChannel, Options } from 'amqplib';
import { EventEmitter } from 'node:events';
import { ConfirmChannelSource } from './rabbit-connection';
import { OutgoingMessage, RabbitPublisher } from './rabbit-publisher';

type Outcome = 'ack' | 'nack' | 'silent' | 'return' | 'channel-lost';

function scriptedChannels(script: Outcome[]) {
  const published: { routingKey: string; options: Options.Publish }[] = [];
  let attempt = 0;
  const source: ConfirmChannelSource = {
    confirmChannel: () => {
      const outcome = script[Math.min(attempt, script.length - 1)];
      if (outcome === 'channel-lost') {
        attempt++;
        return Promise.reject(new Error('Channel closed'));
      }
      const ch = new EventEmitter() as EventEmitter & {
        publish: ConfirmChannel['publish'];
      };
      ch.publish = (_ex, routingKey, _content, options, cb) => {
        const now = script[Math.min(attempt++, script.length - 1)];
        published.push({ routingKey, options: options ?? {} });
        setImmediate(() => {
          if (now === 'return') {
            ch.emit('return', {
              properties: { messageId: options?.messageId },
            });
          }
          if (now === 'nack') cb?.(new Error('nacked'), {});
          else if (now !== 'silent') cb?.(null, {});
        });
        return true;
      };
      return Promise.resolve(ch as unknown as ConfirmChannel);
    },
  };
  return { source, published };
}

const message: OutgoingMessage = {
  exchange: 'wallet.jobs',
  routingKey: 'job.withdrawal.submit',
  messageId: '42',
  body: { withdrawalId: 'w-1' },
};
const publisher = (source: ConfirmChannelSource, retries = 3) =>
  new RabbitPublisher(source, { timeoutMs: 50, retries, backoffMs: 1 });

beforeAll(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
afterAll(() => jest.restoreAllMocks());

describe('RabbitPublisher', () => {
  it('resolves once the broker confirms, with a persistent, mandatory, identified message', async () => {
    const { source, published } = scriptedChannels(['ack']);
    await publisher(source).publish(message);
    expect(published).toHaveLength(1);
    expect(published[0].options).toMatchObject({
      persistent: true,
      mandatory: true,
      messageId: '42',
      contentType: 'application/json',
    });
  });

  it.each([
    ['a nack', ['nack', 'ack']],
    ['a missing confirm (timeout)', ['silent', 'ack']],
    ['a lost channel', ['channel-lost', 'ack']],
    ['two failures in a row', ['nack', 'silent', 'ack']],
  ] as [string, Outcome[]][])(
    'retries an unconfirmed publish after %s',
    async (_case, script) => {
      const { source, published } = scriptedChannels(script);
      await expect(publisher(source).publish(message)).resolves.toBeUndefined();
      expect(published.map((p) => p.options.messageId)).toEqual(
        Array(published.length).fill('42'),
      );
    },
  );

  it('caps the wait for a channel too, and never publishes on a channel that arrives late', async () => {
    let publishes = 0;
    const late: ConfirmChannelSource = {
      confirmChannel: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            const ch = new EventEmitter() as EventEmitter & {
              publish: ConfirmChannel['publish'];
            };
            ch.publish = () => {
              publishes++;
              return true;
            };
            resolve(ch as unknown as ConfirmChannel);
          }, 80),
        ),
    };
    await expect(publisher(late, 0).publish(message)).rejects.toMatchObject({
      reason: 'NOT_CONFIRMED',
    });
    await new Promise((r) => setTimeout(r, 120)); // the channel has arrived by now
    expect(publishes).toBe(0);
  });

  it('reports its worst-case duration: every attempt capped, plus the backoff', () => {
    const p = new RabbitPublisher(scriptedChannels(['ack']).source, {
      timeoutMs: 5000,
      retries: 3,
      backoffMs: 200,
    });
    expect(p.maxPublishMs()).toBe(4 * 5000 + 200 * (1 + 2 + 3));
  });

  it('gives up with NOT_CONFIRMED after retries + 1 attempts', async () => {
    const { source, published } = scriptedChannels(['nack']);
    await expect(publisher(source, 2).publish(message)).rejects.toMatchObject({
      name: 'PublishError',
      reason: 'NOT_CONFIRMED',
    });
    expect(published).toHaveLength(3);
  });

  it('does not retry an unroutable message: UNROUTABLE at once', async () => {
    const { source, published } = scriptedChannels(['return', 'ack']);
    await expect(publisher(source).publish(message)).rejects.toMatchObject({
      reason: 'UNROUTABLE',
    });
    expect(published).toHaveLength(1);
  });
});
