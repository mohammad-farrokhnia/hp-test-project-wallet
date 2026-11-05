import { extname, join } from 'node:path';
import { types } from 'pg';
import { DataSource, DataSourceOptions } from 'typeorm';

const DATE_OID = 1082;
types.setTypeParser(DATE_OID, (value: string) => value);
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
