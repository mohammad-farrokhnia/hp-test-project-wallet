import { Logger } from '@nestjs/common';
import { connect, ChannelModel } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { loadConfig } from '../../../config/app-config';
import { connectTestDb, describeDb } from '../../../database/int-testing';
import { TransactionRunner } from '../../../database/transaction-runner';
import { RabbitConnection } from '../rabbit/rabbit-connection';
import { OutgoingMessage, RabbitPublisher } from '../rabbit/rabbit-publisher';
import { buildTopology, JOBS_EXCHANGE } from '../topology';
import { Envelope } from '../envelope';
import { OutboxRelay, Publisher, RelayOptions } from './outbox-relay';
import { OutboxRepository } from './outbox.repository';

/** Records every publish; `behaviour` decides per message. */
class FakePublisher implements Publisher {
  readonly sent: string[] = [];
  constructor(
    private readonly behaviour: (
      m: OutgoingMessage,
    ) => void | Promise<void> = async () => {
      await sleep(Math.floor(Math.random() * 2));
    },
    private readonly maxMs = 1000,
  ) {}
  async publish(m: OutgoingMessage): Promise<void> {
    await this.behaviour(m);
    this.sent.push(m.messageId);
  }
  maxPublishMs(): number {
    return this.maxMs;
  }
}

describeDb('OutboxRelay (real PostgreSQL)', () => {
  let ds: DataSource;
  let runner: TransactionRunner;
  const repo = new OutboxRepository();

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    ds = await connectTestDb();
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 5000,
      statementTimeoutMs: 10_000,
    });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    jest.restoreAllMocks();
  });

  const relay = (publisher: Publisher, over: Partial<RelayOptions> = {}) =>
    new OutboxRelay(runner, repo, publisher, {
      batchSize: 50,
      intervalMs: 20,
      claimSeconds: 30,
      ...over,
    });

  /** `count` rows under a fresh aggregate type: this test's rows, among other suites'. */
  const seed = async (count: number) => {
    const tag = `M3-${randomUUID()}`;
    const rows = await ds.query<{ id: string }[]>(
      `INSERT INTO outbox (exchange, routing_key, aggregate_type, aggregate_id, payload)
       SELECT 'wallet.jobs', 'job.withdrawal.sync', $1, $1 || '-' || g,
              jsonb_build_object('withdrawalId', $1 || '-' || g)
         FROM generate_series(1, $2::int) g
       RETURNING id::text`,
      [tag, count],
    );
    return {
      tag,
      ids: rows
        .map((r) => r.id)
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)),
    };
  };
  const state = (tag: string) =>
    ds.query<
      {
        id: string;
        published: boolean;
        claimed: boolean;
        last_error: string | null;
      }[]
    >(
      `SELECT id::text, published_at IS NOT NULL AS published,
              coalesce(claimed_until > now(), false) AS claimed, last_error
         FROM outbox WHERE aggregate_type = $1 ORDER BY id`,
      [tag],
    );
  const expireClaims = (tag: string) =>
    ds.query(
      `UPDATE outbox SET claimed_until = now() - interval '1 second' WHERE aggregate_type = $1`,
      [tag],
    );
  /** Runs rounds until one claims nothing. */
  const drain = async (r: OutboxRelay) => {
    while ((await r.runOnce()).claimed > 0);
  };
  const count = (ids: string[]) =>
    ids.reduce(
      (m, id) => m.set(id, (m.get(id) ?? 0) + 1),
      new Map<string, number>(),
    );

  it('two relays never publish the same row twice (4 relays, 500 rows)', async () => {
    const { tag, ids } = await seed(500);
    const publishers = [1, 2, 3, 4].map(() => new FakePublisher());

    await Promise.all(publishers.map((p) => drain(relay(p))));

    const all = publishers.flatMap((p) => p.sent);
    const times = count(all);
    expect([...times.values()].every((n) => n === 1)).toBe(true);
    expect(ids.every((id) => times.get(id) === 1)).toBe(true);
    expect(
      publishers.filter((p) => p.sent.some((id) => ids.includes(id))).length,
    ).toBeGreaterThan(1);
    expect((await state(tag)).every((r) => r.published)).toBe(true);
  });

  it('a crash mid-batch republishes after the claim expires, and loses nothing', async () => {
    const { tag, ids } = await seed(10);
    // Relay A publishes 4 of these rows, then hangs on the 5th forever: a process that died
    // after publishing, before marking anything sent.
    let mine = 0;
    const crashing = new FakePublisher(async (m) => {
      if (ids.includes(m.messageId) && ++mine === 5)
        await new Promise(() => undefined);
    });
    void relay(crashing, { batchSize: 1000 }).runOnce();
    for (let i = 0; i < 200 && mine < 5; i++) await sleep(10);
    expect(crashing.sent.filter((id) => ids.includes(id))).toEqual(
      ids.slice(0, 4),
    );
    expect((await state(tag)).every((r) => r.claimed && !r.published)).toBe(
      true,
    );

    // While A's claim lasts, another relay leaves the rows alone.
    const b = new FakePublisher();
    await drain(relay(b));
    expect(b.sent.filter((id) => ids.includes(id))).toEqual([]);

    // The claim expires (30 s in real life): every row goes out, the first 4 a second time.
    await expireClaims(tag);
    await drain(relay(b));
    expect(b.sent.filter((id) => ids.includes(id))).toEqual(ids);
    expect((await state(tag)).every((r) => r.published)).toBe(true);
  });

  it('a failed publish keeps the row unsent with its error, and retries it after a backoff', async () => {
    const { tag, ids } = await seed(3);
    let broken = true;
    const flaky = new FakePublisher((m) => {
      if (broken && m.messageId === ids[1]) throw new Error('broker said no');
    });

    await drain(relay(flaky));
    let rows = await state(tag);
    expect(rows.map((r) => r.published)).toEqual([true, false, true]);
    expect(rows[1]).toMatchObject({
      claimed: true,
      last_error: 'broker said no',
    });

    broken = false;
    await drain(relay(flaky)); // still inside its backoff: not retried yet
    expect((await state(tag))[1].published).toBe(false);
    await expireClaims(tag);
    await drain(relay(flaky));
    rows = await state(tag);
    expect(rows.every((r) => r.published && r.last_error === null)).toBe(true);
  });

  it('with a slow broker, never starts a publish that could outlast its claim', async () => {
    const { tag, ids } = await seed(5);
    await drain(
      relay(
        new FakePublisher((m) => {
          if (ids.includes(m.messageId)) throw new Error('not yet');
        }),
      ),
    ); // clears older rows from other suites; ours back off
    await expireClaims(tag);

    let clock = 0;
    const slow = new FakePublisher(() => {
      clock += 12_000; // each publish takes 12 s of the 30 s claim
    }, 1000);
    const result = await relay(slow, { now: () => clock }).runOnce();

    // Window: 30 s − 1 s safety − 1 s worst case = 28 s. Starts at 0, 12 and 24 s; not at 36 s.
    expect(slow.sent.filter((id) => ids.includes(id))).toEqual(ids.slice(0, 3));
    expect(result).toMatchObject({ published: 3, deferred: 2, failed: 0 });
    const rows = await state(tag);
    expect(rows.map((r) => r.published)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    // Deferred rows are left exactly as they were: still claimed by this relay, unpublished.
    expect(rows.slice(3).every((r) => r.claimed && !r.published)).toBe(true);
  });

  it('refuses a claim too short for the slowest publish', () => {
    expect(() =>
      relay(new FakePublisher(undefined, 30_000), { claimSeconds: 30 }),
    ).toThrow(/OUTBOX_CLAIM_SECONDS/);
  });

  it('start() keeps relaying until stop(), which waits for the round in progress', async () => {
    const p = new FakePublisher();
    const r = relay(p);
    r.start();
    const { tag } = await seed(7);
    for (let i = 0; i < 200; i++) {
      if ((await state(tag)).every((row) => row.published)) break;
      await sleep(20);
    }
    await r.stop();
    expect((await state(tag)).every((row) => row.published)).toBe(true);
  });

  describe('end to end with the real broker', () => {
    let admin: ChannelModel;
    let conn: RabbitConnection;
    const topology = buildTopology(`it-${randomUUID()}.`);

    beforeAll(async () => {
      const url = loadConfig().rabbit.url;
      admin = await connect(url);
      conn = new RabbitConnection(url, topology);
      await conn.start();
      await conn.ready();
    });

    afterAll(async () => {
      await conn.close();
      const ch = await admin.createChannel();
      for (const q of topology.queues) await ch.deleteQueue(q.name);
      for (const e of topology.exchanges) await ch.deleteExchange(e.name);
      await admin.close();
    });

    it('an outbox row reaches its queue as the documented envelope', async () => {
      const real = new RabbitPublisher(conn, {
        timeoutMs: 5000,
        retries: 3,
        backoffMs: 50,
      });
      // Same broker, test-only exchange names: route `wallet.jobs` to this test's copy.
      const prefixed: Publisher = {
        publish: (m) =>
          real.publish({ ...m, exchange: `${topology.exchanges[0].name}` }),
        maxPublishMs: () => real.maxPublishMs(),
      };
      expect(topology.exchanges[0].name.endsWith(JOBS_EXCHANGE)).toBe(true);
      const { tag, ids } = await seed(1);

      await drain(relay(prefixed, { batchSize: 1000 }));

      const queue = topology.queues.find((q) =>
        q.name.endsWith('job.withdrawal.sync'),
      )!.name;
      const ch = await admin.createChannel();
      let envelope: Envelope | undefined;
      for (
        let msg = await ch.get(queue, { noAck: true });
        msg;
        msg = await ch.get(queue, { noAck: true })
      ) {
        if (msg.properties.messageId === ids[0]) {
          envelope = JSON.parse(msg.content.toString()) as Envelope;
        }
      }
      await ch.close();
      expect(envelope).toEqual({
        messageId: ids[0],
        type: 'job.withdrawal.sync',
        aggregateType: tag,
        aggregateId: `${tag}-1`,
        occurredAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string,
        payload: { withdrawalId: `${tag}-1` },
      });
      expect((await state(tag))[0].published).toBe(true);
    });
  });
});
