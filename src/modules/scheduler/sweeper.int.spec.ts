import { Logger } from '@nestjs/common';
import { ChannelModel, connect } from 'amqplib';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { loadConfig } from '../../config/app-config';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { Tx, TransactionRunner } from '../../database/transaction-runner';
import {
  buildTopology,
  Envelope,
  OutgoingMessage,
  Publisher,
} from '../messaging';
import { RabbitConnection } from '../messaging/rabbit/rabbit-connection';
import { RabbitPublisher } from '../messaging/rabbit/rabbit-publisher';
import { DueJob, DueWorkSource } from './due-work';
import { Sweeper, SweeperOptions } from './sweeper';

/** A stand-in for withdrawals: rows with a status and `next_check_at`. */
const TABLE = `it_due_probe_${randomBytes(4).toString('hex')}`;

/** Implements the `DueWorkSource` contract exactly as documented: bump first, in one statement. */
class ProbeSource implements DueWorkSource {
  readonly name = 'probe';
  async claimDue(
    tx: Tx,
    limit: number,
    bumpSeconds: number,
  ): Promise<DueJob[]> {
    const rows = await tx.query<{ id: string; status: string }[]>(
      `UPDATE ${TABLE} SET next_check_at = now() + make_interval(secs => $2)
        WHERE id IN (SELECT id FROM ${TABLE} WHERE next_check_at <= now()
                      ORDER BY next_check_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id::text, status`,
      [limit, bumpSeconds],
    );
    // A pg UPDATE through TypeORM returns [rows, count].
    const list = (Array.isArray(rows[0]) ? rows[0] : rows) as unknown as {
      id: string;
      status: string;
    }[];
    return list.map((r) => ({
      job:
        r.status === 'PENDING'
          ? 'job.withdrawal.submit'
          : 'job.withdrawal.sync',
      aggregateType: 'WITHDRAWAL',
      aggregateId: r.id,
      payload: { withdrawalId: r.id },
    }));
  }
}

class FakePublisher implements Publisher {
  readonly sent: OutgoingMessage[] = [];
  constructor(
    private readonly behaviour: (
      m: OutgoingMessage,
    ) => void | Promise<void> = () => undefined,
    private readonly maxMs = 1000,
  ) {}
  async publish(m: OutgoingMessage): Promise<void> {
    await this.behaviour(m);
    this.sent.push(m);
  }
  maxPublishMs(): number {
    return this.maxMs;
  }
  ids(of?: string[]): string[] {
    return this.sent
      .map((m) => (m.body as Envelope).aggregateId)
      .filter((id) => !of || of.includes(id));
  }
}

describeDb('Sweeper (real PostgreSQL)', () => {
  let ds: DataSource;
  let runner: TransactionRunner;
  const source = new ProbeSource();

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation();
    }
    ds = await connectTestDb();
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 5000,
      statementTimeoutMs: 10_000,
    });
    await ds.query(
      `CREATE TABLE ${TABLE} (id uuid PRIMARY KEY, status text NOT NULL, next_check_at timestamptz)`,
    );
    await ds.query(
      `CREATE INDEX ON ${TABLE} (next_check_at) WHERE next_check_at IS NOT NULL`,
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await ds.destroy();
    }
    jest.restoreAllMocks();
  });

  beforeEach(() => ds.query(`TRUNCATE ${TABLE}`));

  const sweeper = (publisher: Publisher, over: Partial<SweeperOptions> = {}) =>
    new Sweeper(runner, publisher, [source], {
      intervalMs: 20,
      batchSize: 50,
      bumpSeconds: 30,
      ...over,
    });
  /** Rows due `ago` seconds ago (negative: due in the future). */
  const seed = async (count: number, status = 'PROCESSING', ago = 1) => {
    const rows = await ds.query<{ id: string }[]>(
      `INSERT INTO ${TABLE} (id, status, next_check_at)
       SELECT gen_random_uuid(), $2, now() - make_interval(secs => $3)
         FROM generate_series(1, $1::int)
       RETURNING id::text`,
      [count, status, ago],
    );
    return rows.map((r) => r.id);
  };
  const makeDue = () =>
    ds.query(`UPDATE ${TABLE} SET next_check_at = now() - interval '1 second'`);
  const drain = async (s: Sweeper) => {
    while ((await s.runOnce()).due > 0);
  };

  it('turns due rows into jobs, routed by status, and leaves rows not yet due alone', async () => {
    const pending = await seed(2, 'PENDING');
    const processing = await seed(2, 'PROCESSING');
    const later = await seed(2, 'PROCESSING', -3600);
    const p = new FakePublisher();

    expect(await sweeper(p).runOnce()).toMatchObject({ due: 4, queued: 4 });
    const byJob = (job: string) =>
      p.sent
        .filter((m) => m.routingKey === job)
        .map((m) => (m.body as Envelope).aggregateId)
        .sort();
    expect(byJob('job.withdrawal.submit')).toEqual([...pending].sort());
    expect(byJob('job.withdrawal.sync')).toEqual([...processing].sort());
    expect(p.ids(later)).toEqual([]);
    expect(p.sent[0]).toMatchObject({ exchange: 'wallet.jobs' });
  });

  it('bumps next_check_at before it publishes', async () => {
    const [id] = await seed(1);
    let bumpedSecondsAhead = 0;
    const p = new FakePublisher(async () => {
      const [{ s }] = await ds.query<{ s: number }[]>(
        `SELECT extract(epoch FROM next_check_at - now())::float8 AS s FROM ${TABLE} WHERE id = $1`,
        [id],
      );
      bumpedSecondsAhead = s;
    });
    await sweeper(p).runOnce();
    expect(bumpedSecondsAhead).toBeGreaterThan(25); // committed before the publish started
  });

  it('a row is never queued twice: 4 sweepers at once, then again straight away', async () => {
    const ids = await seed(300);
    const publishers = [1, 2, 3, 4].map(() => new FakePublisher());

    await Promise.all(publishers.map((p) => drain(sweeper(p))));
    const all = publishers.flatMap((p) => p.ids());
    expect(all).toHaveLength(300);
    expect(new Set(all)).toEqual(new Set(ids));
    expect(publishers.filter((p) => p.sent.length > 0).length).toBeGreaterThan(
      1,
    );

    const again = new FakePublisher();
    expect(await sweeper(again).runOnce()).toMatchObject({ due: 0 });
  });

  it('a lost publish is not retried until the bump passes, then the row is queued again', async () => {
    const [id] = await seed(1);
    let broker = 'down';
    const p = new FakePublisher(() => {
      if (broker === 'down') throw new Error('broker unreachable');
    });

    expect(await sweeper(p).runOnce()).toMatchObject({ due: 1, failed: 1 });
    broker = 'up';
    expect(await sweeper(p).runOnce()).toMatchObject({ due: 0 });
    await makeDue(); // the bump passed
    expect(await sweeper(p).runOnce()).toMatchObject({ due: 1, queued: 1 });
    expect(p.ids()).toEqual([id]);
  });

  it('with a slow broker, never starts a publish that could outlast the bump', async () => {
    const ids = await seed(5);
    let clock = 0;
    const slow = new FakePublisher(() => {
      clock += 12_000;
    }, 1000);
    const r = await sweeper(slow, { now: () => clock }).runOnce();
    expect(r).toMatchObject({ due: 5, queued: 3, deferred: 2 });
    expect(slow.ids()).toEqual(expect.arrayContaining(slow.ids(ids)));
  });

  it('refuses a bump too short for the slowest publish', () => {
    expect(() => sweeper(new FakePublisher(undefined, 30_000))).toThrow(
      /SWEEPER_BUMP_SECONDS/,
    );
  });

  describe('with the real broker', () => {
    let admin: ChannelModel;
    let conn: RabbitConnection;
    let current: ChannelModel | undefined;
    const prefix = `it-${randomUUID()}.`;
    const topology = buildTopology(prefix);

    beforeAll(async () => {
      const url = loadConfig().rabbit.url;
      admin = await connect(url);
      conn = new RabbitConnection(url, topology);
      await conn.start();
      conn.onConnect((m) => (current = m));
      await conn.ready();
    });

    afterAll(async () => {
      await conn.close();
      const ch = await admin.createChannel();
      for (const q of topology.queues) await ch.deleteQueue(q.name);
      for (const e of topology.exchanges) await ch.deleteExchange(e.name);
      await admin.close();
    });

    const waiting = async (job: string) => {
      const ch = await admin.createChannel();
      const { messageCount } = await ch.checkQueue(`${prefix}${job}`);
      await ch.close();
      return messageCount;
    };

    it('jobs resume after the broker loses them: the rows are simply due again', async () => {
      const real = new RabbitPublisher(conn, {
        timeoutMs: 3000,
        retries: 5,
        backoffMs: 200,
      });
      const prefixed: Publisher = {
        publish: (m) =>
          real.publish({ ...m, exchange: `${prefix}${m.exchange}` }),
        maxPublishMs: () => real.maxPublishMs(),
      };
      const s = sweeper(prefixed, { bumpSeconds: 120 });
      await seed(1);

      await s.runOnce();
      expect(await waiting('job.withdrawal.sync')).toBe(1);

      const ch = await admin.createChannel();
      await ch.purgeQueue(`${prefix}job.withdrawal.sync`);
      await ch.close();
      (
        current as unknown as {
          connection: { stream: { destroy(e: Error): void } };
        }
      ).connection.stream.destroy(
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      );
      expect(await waiting('job.withdrawal.sync')).toBe(0);

      await makeDue(); // the bump passes; the row still says there is work
      expect(await s.runOnce()).toMatchObject({ due: 1, queued: 1 });
      expect(await waiting('job.withdrawal.sync')).toBe(1);
    }, 30_000);
  });
});
