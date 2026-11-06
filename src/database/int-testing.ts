import { DataSource } from 'typeorm';
import { databaseUrlFromEnv } from '../config/database-url';
import { createDataSource } from './data-source';
import { runMigrations } from './migrator';

const url = databaseUrlFromEnv();
if (url && !/_test$/.test(new URL(url).pathname.slice(1))) {
  throw new Error('integration specs must run against a *_test database');
}

/**
 * @description `describe` when `POSTGRES_DB` names at a `*_test` database, `describe.skip` otherwise.
 */
export const describeDb = url ? describe : describe.skip;

if (!url) {
  process.stderr.write(
    'integration specs SKIPPED: POSTGRES_DB is not set (put it in .env, or use the compose test service)\n',
  );
}

/**
 * @function connectTestDb
 * @description Opens a DataSource on the test database and applies every pending migration.
 * @returns the initialised DataSource; the caller destroys it
 */
export async function connectTestDb(): Promise<DataSource> {
  const ds = await createDataSource({
    db: { url: url ?? '', lockTimeoutMs: 3000, statementTimeoutMs: 5000 },
  }).initialize();
  await runMigrations(ds);
  return ds;
}

/** Arbitrary key shared by every suite that runs a real `OutboxRelay`. */
const OUTBOX_RELAY_LOCK = 7_410_001;

/**
 * @function lockOutboxRelays
 * @description Serialises the suites that run a real `OutboxRelay`. A relay publishes EVERY unsent outbox row, other suites' included,
 * so two such suites running at once would take each other's rows. The lock is a session-level advisory lock on a connection of its own;
 * a suite that finds it taken waits for the holder to finish.
 * @param ds - the suite's DataSource
 * @returns the function that releases the lock, to call in `afterAll`
 */
export async function lockOutboxRelays(
  ds: DataSource,
): Promise<() => Promise<void>> {
  const qr = ds.createQueryRunner();
  await qr.connect();
  await qr.query('SELECT pg_advisory_lock($1)', [OUTBOX_RELAY_LOCK]);
  return async () => {
    await qr.query('SELECT pg_advisory_unlock($1)', [OUTBOX_RELAY_LOCK]);
    await qr.release();
  };
}
