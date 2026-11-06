import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { loadConfig } from '../../../config/app-config';
import { connectTestDb, describeDb } from '../../../database/int-testing';
import { TransactionRunner } from '../../../database/transaction-runner';
import { InboxService } from '../inbox/inbox.service';
import { OutboxRepository } from '../outbox/outbox.repository';
import {
  MessagingRetentionJob,
  RETENTION_BATCH_SIZE,
} from './messaging-retention.job';

describeDb('MessagingRetentionJob (real PostgreSQL)', () => {
  let ds: DataSource;
  let job: MessagingRetentionJob;
  const { outboxDays, inboxDays } = loadConfig().retention;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    ds = await connectTestDb();
    job = new MessagingRetentionJob(
      new TransactionRunner(ds, {
        lockTimeoutMs: 10_000,
        statementTimeoutMs: 60_000,
      }),
      new OutboxRepository(),
      new InboxService(),
      loadConfig(),
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    jest.restoreAllMocks();
  });

  /** Outbox rows under a fresh aggregate type, so this test's rows are told apart from other suites'. */
  const seedOutbox = async (
    published: string | null,
    count = 1,
    createdAgo = '60 days',
  ) => {
    const tag = `RET-${randomUUID()}`;
    await ds.query(
      `INSERT INTO outbox (exchange, routing_key, aggregate_type, aggregate_id, payload, created_at, published_at)
       SELECT 'wallet.events', 'wallet.balance.changed', $1, $1 || '-' || g, '{}'::jsonb,
              now() - $4::interval,
              CASE WHEN $2::text IS NULL THEN NULL ELSE now() - $2::interval END
         FROM generate_series(1, $3::int) g`,
      [tag, published, count, createdAgo],
    );
    return tag;
  };
  const outboxLeft = async (tag: string) =>
    (
      await ds.query<{ n: string }[]>(
        'SELECT count(*)::text AS n FROM outbox WHERE aggregate_type = $1',
        [tag],
      )
    )[0].n;
  const seedInbox = async (consumer: string, ago: string, count = 1) => {
    await ds.query(
      `INSERT INTO inbox (consumer, message_id, processed_at)
       SELECT $1, $1 || '-' || gen_random_uuid(), now() - $2::interval
         FROM generate_series(1, $3::int)`,
      [consumer, ago, count],
    );
  };
  const inboxLeft = async (consumer: string) =>
    (
      await ds.query<{ n: string }[]>(
        'SELECT count(*)::text AS n FROM inbox WHERE consumer = $1',
        [consumer],
      )
    )[0].n;

  it('deletes outbox rows published longer ago than the retention, and keeps the recent ones', async () => {
    const old = await seedOutbox(`${outboxDays + 1} days`, 3);
    const recent = await seedOutbox('1 hour', 3);
    const edge = await seedOutbox(`${outboxDays - 1} days`, 3);

    await job.run();

    expect(await outboxLeft(old)).toBe('0');
    expect(await outboxLeft(recent)).toBe('3');
    expect(await outboxLeft(edge)).toBe('3');
  });

  it('never deletes an unsent row, however old: it is a message not yet delivered', async () => {
    const unsent = await seedOutbox(null, 4, '90 days');
    await job.run();
    expect(await outboxLeft(unsent)).toBe('4');
  });

  it('deletes inbox ids older than the retention, per consumer, and keeps the rest', async () => {
    const c1 = `ret-${randomUUID()}`;
    const c2 = `ret-${randomUUID()}`;
    await seedInbox(c1, `${inboxDays + 1} days`, 2);
    await seedInbox(c1, '1 day', 2);
    await seedInbox(c2, `${inboxDays + 5} days`, 3);

    await job.run();

    expect(await inboxLeft(c1)).toBe('2');
    expect(await inboxLeft(c2)).toBe('0');
  });

  it('purges in batches until nothing is left, however many there are', async () => {
    const many = await seedOutbox(
      `${outboxDays + 2} days`,
      RETENTION_BATCH_SIZE * 2 + 345,
    );
    await job.run();
    expect(await outboxLeft(many)).toBe('0');
  }, 60_000);

  it('an error during a purge is logged, never thrown, so the timer keeps running', async () => {
    const broken = new MessagingRetentionJob(
      {
        run: () => Promise.reject(new Error('database is down')),
      } as unknown as TransactionRunner,
      new OutboxRepository(),
      new InboxService(),
      loadConfig(),
    );
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await expect(broken.run()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('database is down'),
    );
    error.mockRestore();
  });
});
