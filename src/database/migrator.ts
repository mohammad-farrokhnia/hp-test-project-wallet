import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Arbitrary constant: every migrator takes the same session-level advisory lock. */
const MIGRATION_LOCK_KEY = 7_103_001;

/**
 * @function runMigrations
 * @description Applies pending migrations and returns their names. Safe to run from several
 * processes at once
 * @param ds - the DataSource to run migrations on
 * @returns the names of the migrations that were applied
 */
export async function runMigrations(ds: DataSource): Promise<string[]> {
  const lockHolder = ds.createQueryRunner();
  await lockHolder.connect();
  try {
    await lockHolder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    const applied = await ds.runMigrations({ transaction: 'each' });
    for (const m of applied) Logger.log(`applied ${m.name}`, 'Migrate');
    return applied.map((m) => m.name);
  } finally {
    await lockHolder.query('SELECT pg_advisory_unlock($1)', [
      MIGRATION_LOCK_KEY,
    ]);
    await lockHolder.release();
  }
}
