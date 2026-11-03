import { Logger } from '@nestjs/common';
import { loadConfig } from './config/app-config';
import { createDataSource } from './database/data-source';
import { runMigrations } from './database/migrator';

async function main(): Promise<void> {
  const ds = createDataSource(loadConfig());
  await ds.initialize();
  try {
    const applied = await runMigrations(ds);
    Logger.log(
      applied.length ? `${applied.length} applied` : 'schema is up to date',
      'Migrate',
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((err: unknown) => {
  Logger.error(
    err instanceof Error ? (err.stack ?? err.message) : err,
    '',
    'Migrate',
  );
  process.exit(1);
});
