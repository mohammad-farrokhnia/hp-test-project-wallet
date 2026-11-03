import { DataSource } from 'typeorm';

/**
 * @function fakeDataSource
 * @description A `DataSource` stand-in for tests that boot the app without PostgreSQL.
 * @param query - behaviour of `query`; resolves by default
 * @returns an uninitialised data source whose only working method is `query`
 */
export function fakeDataSource(
  query: () => Promise<unknown> = () => Promise.resolve([{ '?column?': 1 }]),
): DataSource {
  return { isInitialized: false, query } as unknown as DataSource;
}
