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
