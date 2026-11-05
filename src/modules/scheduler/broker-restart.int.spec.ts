import { Logger } from '@nestjs/common';
import { connect } from 'amqplib';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { loadConfig } from '../../config/app-config';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { Tx, TransactionRunner } from '../../database/transaction-runner';
import { buildTopology, JobConsumer, Publisher } from '../messaging';
import { RabbitConnection } from '../messaging/rabbit/rabbit-connection';
import { RabbitPublisher } from '../messaging/rabbit/rabbit-publisher';
import { DueJob, DueWorkSource } from './due-work';
import { Sweeper } from './sweeper';

const TABLE = `it_restart_probe_${randomBytes(4).toString('hex')}`;

const describeChaos = process.env.CHAOS === '1' ? describeDb : describe.skip;

describeChaos('jobs resume after a real RabbitMQ restart', () => {
  let ds: DataSource;
  let conn: RabbitConnection;
  let sweeper: Sweeper;
  let consumer: JobConsumer;
  const prefix = `it-${randomUUID()}.`;
  const topology = buildTopology(prefix);
  const handled: string[] = [];

  const source: DueWorkSource = {
    name: 'restart-probe',
    async claimDue(
      tx: Tx,
      limit: number,
      bumpSeconds: number,
    ): Promise<DueJob[]> {
      const res = await tx.query<[{ id: string }[], number]>(
        `UPDATE ${TABLE} SET next_check_at = now() + make_interval(secs => $2)
          WHERE id IN (SELECT id FROM ${TABLE} WHERE next_check_at <= now()
                        ORDER BY next_check_at LIMIT $1 FOR UPDATE SKIP LOCKED)
         RETURNING id::text`,
        [limit, bumpSeconds],
      );
      return res[0].map((r) => ({
        job: 'job.withdrawal.sync',
        aggregateType: 'WITHDRAWAL',
        aggregateId: r.id,
        payload: { withdrawalId: r.id },
      }));
    },
  };

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation();
    }
    ds = await connectTestDb();
    await ds.query(
      `CREATE TABLE ${TABLE} (id uuid PRIMARY KEY, next_check_at timestamptz)`,
    );
    conn = new RabbitConnection(loadConfig().rabbit.url, topology);
    await conn.start();
    await conn.ready();
    const real = new RabbitPublisher(conn, {
      timeoutMs: 1000,
      retries: 2,
      backoffMs: 100,
    });
    const prefixed: Publisher = {
      publish: (m) =>
        real.publish({ ...m, exchange: `${prefix}${m.exchange}` }),
      maxPublishMs: () => real.maxPublishMs(),
    };
    const runner = new TransactionRunner(ds, {
      lockTimeoutMs: 5000,
      statementTimeoutMs: 10_000,
    });
    sweeper = new Sweeper(runner, prefixed, [source], {
      intervalMs: 200,
      batchSize: 10,
      bumpSeconds: 5, // a lost job is due again within seconds
    });
    consumer = new JobConsumer(
      conn,
      real,
      {
        job: 'job.withdrawal.sync',
        handle: (e) => {
          handled.push(e.aggregateId);
          return Promise.resolve();
        },
      },
      {
        queue: `${prefix}job.withdrawal.sync`,
        prefetch: 10,
        maxAttempts: 5,
        retryBackoffMs: 100,
      },
    );
    sweeper.start();
    consumer.start();
  }, 60_000);

  afterAll(async () => {
    await sweeper?.stop();
    await consumer?.stop(1000);
    await conn?.close();
    const admin = await connect(loadConfig().rabbit.url);
    const ch = await admin.createChannel();
    for (const q of topology.queues) await ch.deleteQueue(q.name);
    for (const e of topology.exchanges) await ch.deleteExchange(e.name);
    await admin.close();
    await ds?.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await ds?.destroy();
    jest.restoreAllMocks();
  }, 60_000);

  const until = async (cond: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out waiting');
      await sleep(100);
    }
  };
  const due = async () => {
    const id = randomUUID();
    await ds.query(`INSERT INTO ${TABLE} VALUES ($1, now())`, [id]);
    return id;
  };

  it('a due row is handled before, during and after `docker compose restart rabbitmq`', async () => {
    const before = await due();
    await until(() => handled.includes(before), 20_000);

    execFileSync('docker', ['compose', 'restart', 'rabbitmq'], {
      stdio: 'ignore',
    });
    const after = await due(); // becomes due while the broker is (re)starting

    await until(() => handled.includes(after), 120_000);
    expect(handled).toEqual(expect.arrayContaining([before, after]));
  }, 180_000);
});
