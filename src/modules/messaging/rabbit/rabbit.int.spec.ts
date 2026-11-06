import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { connect, ChannelModel } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { loadConfig } from '../../../config/app-config';
import { fakeDataSource } from '../../../database/testing';
import { withoutBackgroundWork } from '../../../testing/without-background-work';
import {
  buildTopology,
  DEAD_LETTER_EXCHANGE,
  DEAD_QUEUE,
  declareTopology,
  DELIVERY_LIMIT,
  EVENTS_EXCHANGE,
  JOB_NAMES,
  JOBS_EXCHANGE,
  TOPOLOGY,
  Topology,
} from '../topology';
import { RabbitConnection } from './rabbit-connection';
import { RabbitPublisher } from './rabbit-publisher';

/**
 * Against the real broker (`docker compose up -d --wait rabbitmq`). Every test declares its
 * own prefixed copy of the topology, so it never touches the app's queues, and deletes it.
 */
describe('RabbitMQ topology and publisher (real broker)', () => {
  const url = loadConfig().rabbit.url;
  let admin: ChannelModel;
  const opened: RabbitConnection[] = [];
  const declared: Topology[] = [];

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    admin = await connect(url);
  });

  afterAll(async () => {
    await Promise.all(opened.map((c) => c.close()));
    const ch = await admin.createChannel();
    for (const t of declared) {
      for (const q of t.queues) await ch.deleteQueue(q.name);
      for (const e of t.exchanges) await ch.deleteExchange(e.name);
    }
    await admin.close();
    jest.restoreAllMocks();
  });

  const testTopology = () => {
    const t = buildTopology(`it-${randomUUID()}.`);
    declared.push(t);
    return t;
  };
  const started = async (t: Topology) => {
    const conn = new RabbitConnection(url, t);
    opened.push(conn);
    await conn.start();
    await conn.ready();
    return conn;
  };
  const names = (t: Topology) => ({
    jobs: t.exchanges.find((e) => e.name.endsWith(JOBS_EXCHANGE))!.name,
    queue: (job: string) => t.queues.find((q) => q.name.endsWith(job))!.name,
  });

  it('declares the topology at startup, and declaring it again is a no-op', async () => {
    const t = testTopology();
    await started(t);
    await started(t); // a second worker, or a reconnect: same declarations again

    const ch = await admin.createChannel();
    for (const q of t.queues) {
      await expect(ch.checkQueue(q.name)).resolves.toMatchObject({
        queue: q.name,
        messageCount: 0,
      });
    }
    await ch.close();
  });

  it('refuses a changed queue definition loudly instead of keeping the old one', async () => {
    const t = testTopology();
    await started(t);
    const changed: Topology = {
      ...t,
      queues: t.queues.map((q) => ({
        ...q,
        arguments: { ...q.arguments, 'x-delivery-limit': DELIVERY_LIMIT + 1 },
      })),
    };
    const ch = await admin.createChannel();
    ch.on('error', () => undefined);
    await expect(declareTopology(ch, changed)).rejects.toThrow(
      /PRECONDITION_FAILED/,
    );
  });

  it('a confirmed publish lands in the bound queue as a persistent JSON message', async () => {
    const t = testTopology();
    const conn = await started(t);
    const publisher = new RabbitPublisher(conn, {
      timeoutMs: 5000,
      retries: 3,
      backoffMs: 50,
    });
    const { jobs, queue } = names(t);

    await publisher.publish({
      exchange: jobs,
      routingKey: 'job.withdrawal.sync',
      messageId: '101',
      body: {
        messageId: '101',
        type: 'job.withdrawal.sync',
        aggregateId: 'w-1',
      },
    });

    const ch = await admin.createChannel();
    const msg = await ch.get(queue('job.withdrawal.sync'), { noAck: true });
    expect(msg).not.toBe(false);
    if (msg === false) return;
    expect(msg.properties).toMatchObject({
      messageId: '101',
      deliveryMode: 2,
      contentType: 'application/json',
    });
    expect(JSON.parse(msg.content.toString())).toMatchObject({
      aggregateId: 'w-1',
    });
    await ch.close();
  });

  it('retries after losing its channel and still delivers once confirmed', async () => {
    const t = testTopology();
    const conn = await started(t);
    const publisher = new RabbitPublisher(conn, {
      timeoutMs: 5000,
      retries: 3,
      backoffMs: 50,
    });
    await (await conn.confirmChannel()).close(); // the channel dies under the publisher
    const { jobs, queue } = names(t);

    await publisher.publish({
      exchange: jobs,
      routingKey: 'job.deposit.sync',
      messageId: '102',
      body: {},
    });
    const ch = await admin.createChannel();
    const { messageCount } = await ch.checkQueue(queue('job.deposit.sync'));
    expect(messageCount).toBe(1);
    await ch.close();
  });

  it('refuses a message no queue would receive: UNROUTABLE, not silently dropped', async () => {
    const t = testTopology();
    const conn = await started(t);
    const publisher = new RabbitPublisher(conn, {
      timeoutMs: 5000,
      retries: 3,
      backoffMs: 50,
    });
    await expect(
      publisher.publish({
        exchange: names(t).jobs,
        routingKey: 'job.does.not.exist',
        messageId: '103',
        body: {},
      }),
    ).rejects.toMatchObject({ reason: 'UNROUTABLE' });
  });

  it(`dead-letters a job to job.dead after ${DELIVERY_LIMIT} failed deliveries`, async () => {
    const t = testTopology();
    const conn = await started(t);
    const publisher = new RabbitPublisher(conn, {
      timeoutMs: 5000,
      retries: 0,
      backoffMs: 0,
    });
    const { jobs, queue } = names(t);
    const dead = queue(DEAD_QUEUE);
    await publisher.publish({
      exchange: jobs,
      routingKey: 'job.withdrawal.submit',
      messageId: '104',
      body: {},
    });

    // A consumer that dies without acking: the delivery that counts toward the limit.
    // (RabbitMQ 4 does not count a nack with requeue: see modules.md, messaging.)
    let deliveries = 0;
    for (; deliveries <= DELIVERY_LIMIT + 1; deliveries++) {
      const ch = await admin.createChannel();
      const msg = await ch.get(queue('job.withdrawal.submit'), {
        noAck: false,
      });
      await ch.close();
      if (msg === false) break;
    }
    expect(deliveries).toBe(DELIVERY_LIMIT + 1);

    const ch = await admin.createChannel();
    let deadMsg: Awaited<ReturnType<typeof ch.get>> = false;
    for (let i = 0; i < 50 && deadMsg === false; i++) {
      deadMsg = await ch.get(dead, { noAck: true });
      if (deadMsg === false) await new Promise((r) => setTimeout(r, 50));
    }
    expect(deadMsg && deadMsg.properties.messageId).toBe('104');
    await ch.close();
  });

  it('the worker role declares the app topology when it boots', async () => {
    const ref = await withoutBackgroundWork(
      Test.createTestingModule({ imports: [AppModule.forRole('worker')] }),
    )
      .overrideProvider(DataSource)
      .useValue(fakeDataSource())
      .compile();
    const app: INestApplication = ref.createNestApplication();
    await app.init();
    try {
      await app.get(RabbitConnection).ready();
      const ch = await admin.createChannel();
      for (const q of TOPOLOGY.queues) {
        await expect(ch.checkQueue(q.name)).resolves.toMatchObject({
          queue: q.name,
        });
      }
      await ch.checkExchange(DEAD_LETTER_EXCHANGE);
      await ch.checkExchange(EVENTS_EXCHANGE);
      await ch.checkQueue('notify.events');
      expect(JOB_NAMES).toHaveLength(3);
      await ch.close();
    } finally {
      await app.close();
    }
  });
});
