import { Logger } from '@nestjs/common';
import { ChannelModel, connect, Message } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from '../../../config/app-config';
import { Envelope } from '../envelope';
import { RabbitConnection } from '../rabbit/rabbit-connection';
import { RabbitPublisher } from '../rabbit/rabbit-publisher';
import {
  buildTopology,
  DEAD_QUEUE,
  JOBS_EXCHANGE,
  Topology,
} from '../topology';
import { ATTEMPT_HEADER, JobConsumer, JobHandler } from './job-consumer';

const JOB = 'job.withdrawal.sync' as const;
const MAX_ATTEMPTS = 5;

type Handle = JobHandler['handle'];

/**
 * Cuts the TCP connection under amqplib with a reset, as a network blip or a broker restart does.
 * (A bare `destroy()` emits no error, so amqplib would never notice: not what a real drop looks like.)
 */
function dropConnection(model: ChannelModel): void {
  (
    model as unknown as {
      connection: { stream: { destroy(err: Error): void } };
    }
  ).connection.stream.destroy(
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  );
}

jest.setTimeout(30_000); // reconnect tests wait for the broker

const until = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(20);
  }
};

/** Against the real broker; every test gets its own prefixed copy of the topology. */
describe('JobConsumer (real broker)', () => {
  const url = loadConfig().rabbit.url;
  let admin: ChannelModel;
  const topologies: Topology[] = [];
  const connections: RabbitConnection[] = [];
  const consumers: JobConsumer[] = [];

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation();
    }
    admin = await connect(url);
  });

  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((c) => c.stop(500)));
  });

  afterAll(async () => {
    await Promise.all(connections.map((c) => c.close()));
    const ch = await admin.createChannel();
    for (const t of topologies) {
      for (const q of t.queues) await ch.deleteQueue(q.name);
      for (const e of t.exchanges) await ch.deleteExchange(e.name);
    }
    await admin.close();
    jest.restoreAllMocks();
  });

  /** A fresh topology, connection and publisher, and helpers around them. */
  async function setup() {
    const prefix = `it-${randomUUID()}.`;
    const t = buildTopology(prefix);
    topologies.push(t);
    const conn = new RabbitConnection(url, t);
    connections.push(conn);
    await conn.start();
    let current: ChannelModel | undefined;
    conn.onConnect((m) => (current = m)); // before the first connect completes
    await conn.ready();
    const publisher = new RabbitPublisher(conn, {
      timeoutMs: 2000,
      retries: 5,
      backoffMs: 100,
    });
    const queue = `${prefix}${JOB}`;
    const dead = `${prefix}${DEAD_QUEUE}`;

    const consume = (handle: Handle, prefetch = 10) => {
      const c = new JobConsumer(
        conn,
        publisher,
        { job: JOB, handle },
        { queue, prefetch, maxAttempts: MAX_ATTEMPTS, retryBackoffMs: 1 },
      );
      consumers.push(c);
      c.start();
      return c;
    };
    const send = async (): Promise<Envelope> => {
      const id = randomUUID();
      const envelope: Envelope = {
        messageId: randomUUID(),
        type: JOB,
        aggregateType: 'WITHDRAWAL',
        aggregateId: id,
        occurredAt: new Date().toISOString(),
        payload: { withdrawalId: id },
      };
      await publisher.publish({
        exchange: `${prefix}${JOBS_EXCHANGE}`,
        routingKey: JOB,
        messageId: envelope.messageId,
        body: envelope,
      });
      return envelope;
    };
    const sendRaw = async (raw: string) => {
      const ch = await admin.createConfirmChannel();
      ch.publish(`${prefix}${JOBS_EXCHANGE}`, JOB, Buffer.from(raw), {
        messageId: 'raw',
        persistent: true,
      });
      await ch.waitForConfirms();
      await ch.close();
    };
    const deadLetters = async () => {
      const ch = await admin.createChannel();
      const out: Message[] = [];
      for (
        let m = await ch.get(dead, { noAck: true });
        m;
        m = await ch.get(dead, { noAck: true })
      ) {
        out.push(m);
      }
      await ch.close();
      return out;
    };
    const ready = async () => {
      const ch = await admin.createChannel();
      const { messageCount } = await ch.checkQueue(queue);
      await ch.close();
      return messageCount;
    };
    const drop = () => dropConnection(current!);
    return { consume, send, sendRaw, deadLetters, ready, drop };
  }

  it('acks a job once its handler returns', async () => {
    const { consume, send, deadLetters, ready } = await setup();
    const seen: string[] = [];
    consume((e) => {
      seen.push(e.aggregateId);
      return Promise.resolve();
    });
    const e = await send();

    await until(() => seen.length === 1);
    await sleep(200);
    expect(seen).toEqual([e.aggregateId]);
    expect(await ready()).toBe(0);
    expect(await deadLetters()).toEqual([]);
  });

  it('a thrown handler is redelivered, with the attempt counted, until it succeeds', async () => {
    const { consume, send, deadLetters } = await setup();
    const attempts: number[] = [];
    consume((_e, ctx) => {
      attempts.push(ctx.attempt);
      return ctx.attempt < 3
        ? Promise.reject(new Error('provider timeout'))
        : Promise.resolve();
    });
    await send();

    await until(() => attempts.length === 3);
    await sleep(200);
    expect(attempts).toEqual([1, 2, 3]);
    expect(await deadLetters()).toEqual([]);
  });

  it(`a poison message ends in job.dead after ${MAX_ATTEMPTS} attempts`, async () => {
    const { consume, send, deadLetters } = await setup();
    const attempts: number[] = [];
    consume((_e, ctx) => {
      attempts.push(ctx.attempt);
      return Promise.reject(new Error('always fails'));
    });
    const e = await send();

    let dead: Message[] = [];
    await until(async () => (dead = await deadLetters()).length === 1);
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(dead[0].properties.messageId).toBe(e.messageId);
    expect(dead[0].properties.headers?.[ATTEMPT_HEADER]).toBe(MAX_ATTEMPTS);
  });

  it('a message that is not an envelope goes straight to job.dead, unhandled', async () => {
    const { consume, sendRaw, deadLetters } = await setup();
    let calls = 0;
    consume(() => {
      calls++;
      return Promise.resolve();
    });
    await sendRaw('{"not":"an envelope"}');

    let dead: Message[] = [];
    await until(async () => (dead = await deadLetters()).length === 1);
    expect(calls).toBe(0);
    expect(dead[0].content.toString()).toBe('{"not":"an envelope"}');
  });

  it('acks only after the handler finished: a worker that dies mid-job loses nothing', async () => {
    const { consume, send, drop } = await setup();
    let release!: () => void;
    const stuck = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    consume((e) => {
      calls.push(e.aggregateId);
      // First delivery: still working when the worker dies, so nothing is acked.
      return calls.length === 1 ? stuck : Promise.resolve();
    });
    const e = await send();
    await until(() => calls.length === 1);

    drop(); // the worker's connection dies with the job unacked
    await until(() => calls.length === 2, 20_000); // the broker delivers it again
    expect(calls).toEqual([e.aggregateId, e.aggregateId]);
    release(); // the old handler finishes; its ack goes nowhere, which is fine
  });

  it('takes at most prefetch jobs at a time', async () => {
    const { consume, send } = await setup();
    let running = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    consume(async () => {
      running++;
      peak = Math.max(peak, running);
      await gate;
      running--;
    }, 3);
    for (let i = 0; i < 10; i++) await send();

    await until(() => running === 3);
    await sleep(300);
    expect(peak).toBe(3);
    release();
    await until(() => running === 0);
  });

  it('subscribes again after the connection drops, and keeps consuming', async () => {
    const { consume, send, drop } = await setup();
    const seen: string[] = [];
    consume((e) => {
      seen.push(e.aggregateId);
      return Promise.resolve();
    });
    const a = await send();
    await until(() => seen.length === 1);

    drop();
    const b = await send(); // the publisher retries until reconnected
    await until(() => seen.includes(b.aggregateId), 20_000);
    // At least once: an ack in flight when the connection dropped is lost, so `a` may come again.
    expect(new Set(seen)).toEqual(new Set([a.aggregateId, b.aggregateId]));
  });
});
