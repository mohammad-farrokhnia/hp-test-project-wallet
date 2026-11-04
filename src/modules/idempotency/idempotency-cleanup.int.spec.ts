import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Money } from '../../common/money';
import { AppConfig } from '../../config/app-config';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { Tx, TransactionRunner } from '../../database/transaction-runner';
import { newLedgerService } from '../ledger/testing';
import {
  IdempotencyCleanupJob,
  PURGE_BATCH_SIZE,
} from './idempotency-cleanup.job';
import { IdempotencyKeysRepository } from './repositories/idempotency-keys.repository';
import { newIdempotencyService } from './testing';

describeDb('IdempotencyCleanupJob (real PostgreSQL)', () => {
  let ds: DataSource;
  let runner: TransactionRunner;
  let job: IdempotencyCleanupJob;
  const keys = new IdempotencyKeysRepository();
  const config = {
    idempotency: { retentionDays: 7, cleanupIntervalMinutes: 60 },
  } as AppConfig;

  beforeAll(async () => {
    ds = await connectTestDb();
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 5000,
      statementTimeoutMs: 20_000,
    });
    job = new IdempotencyCleanupJob(runner, keys, config);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  /** Inserts `count` keys created `daysAgo` days ago; returns them. */
  const seedKeys = async (count: number, daysAgo: number) => {
    const prefix = `purge-${randomUUID()}-`;
    await ds.query(
      `INSERT INTO idempotency_keys (key, scope, fingerprint, status, created_at)
       SELECT $1 || g, 'POST /withdrawals', 'fp', 'IN_PROGRESS', now() - make_interval(days => $3)
         FROM generate_series(1, $2) g`,
      [prefix, count, daysAgo],
    );
    return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
  };
  const remaining = async (list: string[]) => {
    const [{ n }] = await ds.query<{ n: string }[]>(
      'SELECT count(*)::text AS n FROM idempotency_keys WHERE key = ANY($1)',
      [list],
    );
    return Number.parseInt(n, 10);
  };

  it('removes keys older than the retention and keeps younger ones', async () => {
    const old = await seedKeys(3, 8);
    const young = await seedKeys(3, 6);

    expect(await job.purgeOlderThan(7)).toBeGreaterThanOrEqual(3);
    expect(await remaining(old)).toBe(0);
    expect(await remaining(young)).toBe(3);
  });

  it('works through a backlog bigger than one batch', async () => {
    const old = await seedKeys(PURGE_BATCH_SIZE * 2 + 500, 30);
    expect(await job.purgeOlderThan(7)).toBeGreaterThanOrEqual(old.length);
    expect(await remaining(old)).toBe(0);
  });

  it('two workers purging at once share the work and both finish', async () => {
    const old = await seedKeys(PURGE_BATCH_SIZE + 200, 30);
    const [a, b] = await Promise.all([
      job.purgeOlderThan(7),
      job.purgeOlderThan(7),
    ]);
    expect(a + b).toBeGreaterThanOrEqual(old.length);
    expect(await remaining(old)).toBe(0);
  });

  it('skips a key a request holds right now, and takes it on the next round', async () => {
    const [held] = await seedKeys(1, 8);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const request = runner.run(async (tx) => {
      await keys.lockKey(tx, held);
      locked();
      await released;
    });
    await isLocked;

    await job.purgeOlderThan(7);
    expect(await remaining([held])).toBe(1);

    release();
    await request;
    await job.purgeOlderThan(7);
    expect(await remaining([held])).toBe(0);
  });

  it('after a key is purged, a repeat runs again but the journal unique key still books the money once', async () => {
    const idem = newIdempotencyService();
    const ledger = newLedgerService();
    const key = `purge-${randomUUID()}`;
    const userId = `i3_${randomUUID().slice(0, 12)}`;
    const adjustmentId = randomUUID();
    const body = { userId, amount: '500' };

    const handle = () =>
      runner.run(async (tx: Tx) => {
        const claim = await idem.claim(tx, {
          key,
          scope: 'POST /internal/adjustments',
          body,
        });
        if (claim.kind === 'REPLAY') return { replayed: true, booked: false };
        const ids = await ledger.ensureUserAccounts(tx, userId, 'IRR');
        const ops = await ledger.systemAccountId(tx, 'OPS_ADJUSTMENTS', 'IRR');
        const { alreadyBooked } = await ledger.post(tx, {
          kind: 'ADJUSTMENT_CREDIT',
          refId: adjustmentId,
          currency: 'IRR',
          lines: [
            { accountId: ops, amount: Money.rial(-500n) },
            { accountId: ids.available, amount: Money.rial(500n) },
          ],
        });
        await idem.complete(tx, key, { status: 201, body: { adjustmentId } });
        return { replayed: false, booked: !alreadyBooked };
      });

    expect(await handle()).toEqual({ replayed: false, booked: true });
    await ds.query(
      `UPDATE idempotency_keys SET created_at = now() - interval '8 days' WHERE key = $1`,
      [key],
    );
    await job.purgeOlderThan(7);
    expect(await remaining([key])).toBe(0);

    expect(await handle()).toEqual({ replayed: false, booked: false });
    const [{ balance }] = await ds.query<{ balance: string }[]>(
      `SELECT balance_minor::text AS balance FROM accounts
        WHERE user_id = $1 AND kind = 'AVAILABLE' AND currency = 'IRR'`,
      [userId],
    );
    expect(balance).toBe('500');
  });

  it('a failed round is logged, not thrown, so the timer keeps running', async () => {
    const broken = new IdempotencyCleanupJob(
      {
        run: () => Promise.reject(new Error('db down')),
      } as unknown as TransactionRunner,
      keys,
      config,
    );
    await expect(broken.run()).resolves.toBeUndefined();
  });
});
