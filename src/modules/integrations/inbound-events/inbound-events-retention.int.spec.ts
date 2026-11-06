import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { loadConfig } from '../../../config/app-config';
import { connectTestDb, describeDb } from '../../../database/int-testing';
import { TransactionRunner } from '../../../database/transaction-runner';
import {
  INBOUND_RETENTION_BATCH_SIZE,
  InboundEventsRetentionJob,
} from './inbound-events-retention.job';
import { InboundEvents } from './inbound-events.service';

describeDb('InboundEventsRetentionJob (real PostgreSQL)', () => {
  let ds: DataSource;
  let job: InboundEventsRetentionJob;
  const { inboundEventsDays } = loadConfig().retention;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    ds = await connectTestDb();
    job = new InboundEventsRetentionJob(
      new TransactionRunner(ds, {
        lockTimeoutMs: 10_000,
        statementTimeoutMs: 60_000,
      }),
      new InboundEvents(),
      loadConfig(),
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    jest.restoreAllMocks();
  });

  const seed = async (ago: string, count = 1) => {
    const reference = `RET-${randomUUID()}`;
    await ds.query(
      `INSERT INTO inbound_events (source, reference, signature_valid, headers, raw_body, outcome, received_at)
       SELECT 'PSP_CALLBACK', $1, NULL, '{}'::jsonb, '{}', 'ACCEPTED', now() - $2::interval
         FROM generate_series(1, $3::int)`,
      [reference, ago, count],
    );
    return reference;
  };
  const left = async (reference: string) =>
    (
      await ds.query<{ n: string }[]>(
        'SELECT count(*)::text AS n FROM inbound_events WHERE reference = $1',
        [reference],
      )
    )[0].n;

  it('deletes recorded events older than the retention and keeps the rest', async () => {
    const old = await seed(`${inboundEventsDays + 1} days`, 3);
    const recent = await seed('2 days', 3);
    const edge = await seed(`${inboundEventsDays - 1} days`, 3);

    await job.run();

    expect(await left(old)).toBe('0');
    expect(await left(recent)).toBe('3');
    expect(await left(edge)).toBe('3');
  });

  it('purges in batches until nothing is left', async () => {
    const many = await seed(
      `${inboundEventsDays + 3} days`,
      INBOUND_RETENTION_BATCH_SIZE + 250,
    );
    await job.run();
    expect(await left(many)).toBe('0');
  }, 60_000);

  it('an error during a purge is logged, never thrown, so the timer keeps running', async () => {
    const broken = new InboundEventsRetentionJob(
      {
        run: () => Promise.reject(new Error('database is down')),
      } as unknown as TransactionRunner,
      new InboundEvents(),
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
