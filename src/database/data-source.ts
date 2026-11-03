import { extname, join } from 'node:path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { AppConfig } from '../config/app-config';

const MIGRATIONS_GLOB = join(
  __dirname,
  'migrations',
  `*${extname(__filename)}`,
);

export function createDataSource(
  config: Pick<AppConfig, 'db'>,
  overrides: Partial<DataSourceOptions> = {},
): DataSource {
  return new DataSource({
    type: 'postgres',
    url: config.db.url,
    migrations: [MIGRATIONS_GLOB],
    synchronize: false,
    migrationsRun: false,
    ...overrides,
  } as DataSourceOptions);
}
