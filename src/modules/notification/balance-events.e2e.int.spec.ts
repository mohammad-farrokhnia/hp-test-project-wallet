import { Logger } from '@nestjs/common';
import { connect, ChannelModel } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { Money } from '../../common/money';
import { loadConfig } from '../../config/app-config';
import {
  connectTestDb,
  describeDb,
  lockOutboxRelays,
} from '../../database/int-testing';
import { TransactionRunner } from '../../database/transaction-runner';
import { newIdempotencyService } from '../idempotency/testing';
import { newLedgerService } from '../ledger/testing';
import {
  buildTopology,
  Envelope,
  InboxService,
  JobConsumer,
  Publisher,
} from '../messaging';
import { OutboxRelay } from '../messaging/outbox/outbox-relay';
import { OutboxRepository } from '../messaging/outbox/outbox.repository';
import { RabbitConnection } from '../messaging/rabbit/rabbit-connection';
import { RabbitPublisher } from '../messaging/rabbit/rabbit-publisher';
import { TransferService } from '../transfer/transfer.service';
import { TransfersRepository } from '../transfer/transfers.repository';
import { NotificationHandler } from './notification.handler';
import { NotificationsRepository } from './notifications.repository';

/** `beforeAll` may wait for the relay suite to release the relay lock. */
jest.setTimeout(120_000);

/**
 * B4 end to end on the real PostgreSQL and the real RabbitMQ: a transfer commits, its two balance events sit in the outbox,
 * the relay publishes them to `wallet.events`, `notify.events` delivers them to the notification consumer.
 * Topology names are private to this test; the relay is the real `OutboxRelay`, the consumer the real `JobConsumer`.
 */
describeDb('balance events end to end (real PostgreSQL and RabbitMQ)', () => {
  let ds: DataSource;
  let runner: TransactionRunner;
  let admin: ChannelModel;
  let conn: RabbitConnection;
  let publisher: RabbitPublisher;
  let prefixed: Publisher;
  let consumer: JobConsumer;
  let unlockRelays: () => Promise<void>;
  const prefix = `it-${randomUUID()}.`;
  const topology = buildTopology(prefix);
  const ledger = newLedgerService();
  const repo = new OutboxRepository();
  const notifications = new NotificationsRepository();

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    ds = await connectTestDb();
    unlockRelays = await lockOutboxRelays(ds);
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 20_000,
    });
    const url = loadConfig().rabbit.url;
    admin = await connect(url);
    conn = new RabbitConnection(url, topology);
    await conn.start();
    await conn.ready();
    publisher = new RabbitPublisher(conn, {
      timeoutMs: 5000,
      retries: 3,
      backoffMs: 50,
    });
    prefixed = {
      publish: (m) =>
        publisher.publish({ ...m, exchange: `${prefix}${m.exchange}` }),
      maxPublishMs: () => publisher.maxPublishMs(),
    };
    const handler = new NotificationHandler(
      runner,
      new InboxService(),
      ledger,
      notifications,
    );
    consumer = new JobConsumer(conn, publisher, handler, {
      queue: `${prefix}notify.events`,
      prefetch: 10,
      maxAttempts: 5,
      retryBackoffMs: 5,
    });
    consumer.start();
  });

  afterAll(async () => {
    await consumer?.stop(500);
    await conn?.close();
    const ch = await admin.createChannel();
    for (const q of topology.queues) await ch.deleteQueue(q.name);
    for (const e of topology.exchanges) await ch.deleteExchange(e.name);
    await admin.close();
    await unlockRelays?.();
    if (ds?.isInitialized) await ds.destroy();
    jest.restoreAllMocks();
  });

  const relay = () =>
    new OutboxRelay(runner, repo, prefixed, {
      batchSize: 100,
      intervalMs: 20,
      claimSeconds: 30,
    });
  const transfers = new TransferService(
    {
      run: (fn, opts) => runner.run(fn, opts),
    } as TransactionRunner,
    newIdempotencyService(),
    ledger,
    new TransfersRepository(),
  );

  const newUser = () => `b4e_${randomUUID().slice(0, 12)}`;
  const fund = (userId: string, toman: bigint) =>
    runner.run((tx) =>
      ledger.creditUser(tx, {
        userId,
        amount: Money.toman(toman),
        source: 'OPS_ADJUSTMENTS',
        kind: 'ADJUSTMENT_CREDIT',
        refId: randomUUID(),
      }),
    );
  const send = (from: string, to: string, toman: bigint) =>
    transfers.request(
      {
        fromUserId: from,
        toUserId: to,
        amount: Money.toman(toman),
        body: { from, to, toman: toman.toString() },
      },
      `b4-${randomUUID()}`,
    );
  /** The outbox events of these users: how many exist, and how many are still unsent. */
  const outbox = async (users: string[]) =>
    (
      await ds.query<{ total: string; unsent: string; ids: string[] }[]>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE published_at IS NULL)::text AS unsent,
                coalesce(array_agg(id::text ORDER BY id), '{}') AS ids
           FROM outbox WHERE exchange = 'wallet.events' AND aggregate_id = ANY($1)`,
        [users],
      )
    )[0];
  const delivered = async (users: string[]) =>
    (
      await ds.query<{ n: string; distinct: string }[]>(
        `SELECT count(*)::text AS n, count(DISTINCT message_id)::text AS distinct
           FROM notifications WHERE user_id = ANY($1)`,
        [users],
      )
    )[0];
  async function until(check: () => Promise<boolean>, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return;
      await sleep(50);
    }
    throw new Error('timed out waiting for the events to be delivered');
  }

  it('events written while the relay is stopped stay in the outbox, and a relay started later delivers every one of them', async () => {
    const [a, b] = [newUser(), newUser()];
    await fund(a, 1_000n);
    await fund(b, 1_000n);
    for (let i = 0; i < 6; i++) {
      await send(a, b, 10n);
      await send(b, a, 5n);
    }

    const waiting = await outbox([a, b]);
    expect(parseInt(waiting.total, 10)).toBe(2 + 12 * 2);
    expect(waiting.unsent).toBe(waiting.total);
    expect((await delivered([a, b])).n).toBe('0');

    const r = relay();
    r.start();
    try {
      await until(async () => (await delivered([a, b])).n === waiting.total);
    } finally {
      await r.stop();
    }

    expect((await outbox([a, b])).unsent).toBe('0');
    const done = await delivered([a, b]);
    expect(done).toEqual({ n: waiting.total, distinct: waiting.total });
  }, 60_000);

  it('a relay stopped in the middle of a stream of transfers, then restarted: nothing lost, nothing doubled', async () => {
    const [a, b] = [newUser(), newUser()];
    await fund(a, 10_000n);
    await fund(b, 10_000n);

    const first = relay();
    first.start();
    for (let i = 0; i < 5; i++) await send(a, b, 7n);
    await first.stop();
    for (let i = 0; i < 5; i++) await send(b, a, 3n);
    const stranded = await outbox([a, b]);
    expect(parseInt(stranded.unsent, 10)).toBeGreaterThan(0);

    const second = relay();
    second.start();
    for (let i = 0; i < 5; i++) await send(a, b, 1n);
    try {
      const expected = (await outbox([a, b])).total;
      await until(async () => (await delivered([a, b])).n === expected);
    } finally {
      await second.stop();
    }

    const sent = await outbox([a, b]);
    expect(sent.unsent).toBe('0');
    const done = await delivered([a, b]);
    expect(done.n).toBe(sent.total);
    expect(done.distinct).toBe(sent.total);
  }, 60_000);

  it('the balances in a notification are those read at handling time, and every transfer is announced to both sides', async () => {
    const [a, b] = [newUser(), newUser()];
    await fund(a, 1_000n);
    await send(a, b, 400n);
    const r = relay();
    r.start();
    try {
      await until(async () => (await delivered([a, b])).n === '3');
    } finally {
      await r.stop();
    }
    const forB = await runner.run((tx) => notifications.listForUser(tx, b), {
      readOnly: true,
    });
    expect(forB).toHaveLength(1);
    expect(forB[0].available.minor).toBe(4_000n);
    const forA = await runner.run((tx) => notifications.listForUser(tx, a), {
      readOnly: true,
    });
    expect(forA).toHaveLength(2);
    expect(forA[1].available.minor).toBe(6_000n);
  }, 60_000);

  it('a duplicate delivery from the broker is applied once', async () => {
    const [a, b] = [newUser(), newUser()];
    await fund(a, 1_000n);
    await send(a, b, 100n);
    const r = relay();
    r.start();
    try {
      await until(async () => (await delivered([a, b])).n === '3');
    } finally {
      await r.stop();
    }
    const [row] = await ds.query<
      { id: string; payload: Record<string, string> }[]
    >(
      `SELECT id::text, payload FROM outbox WHERE exchange = 'wallet.events' AND aggregate_id = $1 ORDER BY id DESC LIMIT 1`,
      [b],
    );
    const envelope: Envelope = {
      messageId: row.id,
      type: 'wallet.balance.changed',
      aggregateType: 'WALLET',
      aggregateId: b,
      occurredAt: new Date().toISOString(),
      payload: row.payload,
    };
    const before = await delivered([a, b]);

    for (let i = 0; i < 4; i++) {
      await publisher.publish({
        exchange: `${prefix}wallet.events`,
        routingKey: 'wallet.balance.changed',
        messageId: envelope.messageId,
        body: envelope,
      });
    }
    await sleep(1500);

    expect(await delivered([a, b])).toEqual(before);
    const [{ n }] = await ds.query<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM inbox WHERE consumer = 'notification' AND message_id = $1`,
      [row.id],
    );
    expect(n).toBe('1');
  }, 60_000);
});
