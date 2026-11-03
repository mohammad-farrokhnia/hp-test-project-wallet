import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { TransactionRunner, isRetryableDbError } from './transaction-runner';

const failure = (code: string) =>
  new QueryFailedError(
    'UPDATE …',
    [],
    Object.assign(new Error(code), { code }),
  );

function setup() {
  const queries: { sql: string; params?: unknown[] }[] = [];
  const tx = {
    query: (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return Promise.resolve([]);
    },
  } as unknown as EntityManager;
  const isolation: string[] = [];
  const ds = {
    transaction: (
      level: string,
      fn: (m: EntityManager) => Promise<unknown>,
    ) => {
      isolation.push(level);
      return fn(tx);
    },
  } as unknown as DataSource;
  const runner = new TransactionRunner(ds, {
    lockTimeoutMs: 3000,
    statementTimeoutMs: 5000,
    retryBackoffMs: 0,
  });
  return { runner, queries, isolation };
}

function failing(err: Error, times: number) {
  let calls = 0;
  const fn = jest.fn(() => {
    calls++;
    return calls <= times ? Promise.reject(err) : Promise.resolve('done');
  });
  return fn;
}

describe('TransactionRunner', () => {
  it('runs READ COMMITTED with lock_timeout and statement_timeout set locally', async () => {
    const { runner, queries, isolation } = setup();
    await runner.run(() => Promise.resolve());
    expect(isolation).toEqual(['READ COMMITTED']);
    expect(queries[0].sql).toContain(`set_config('lock_timeout', $1, true)`);
    expect(queries[0].params).toEqual(['3000ms', '5000ms']);
  });

  it('retries the whole function after a deadlock (40P01)', async () => {
    const fn = failing(failure('40P01'), 2);
    await expect(setup().runner.run(fn)).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries a serialization failure (40001)', async () => {
    const fn = failing(failure('40001'), 1);
    await expect(setup().runner.run(fn)).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 retries (4 attempts) and rethrows the original error', async () => {
    const err = failure('40P01');
    const fn = failing(err, 99);
    await expect(setup().runner.run(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('honours a custom retry count, including none', async () => {
    const fn = failing(failure('40P01'), 99);
    await expect(setup().runner.run(fn, { retries: 0 })).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['lock timeout (55P03)', failure('55P03')],
    ['unique violation (23505)', failure('23505')],
    ['check violation (23514)', failure('23514')],
    ['a plain Error', new Error('boom')],
  ])('does not retry %s', async (_name, err) => {
    const fn = failing(err, 99);
    await expect(setup().runner.run(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('classifies only deadlock and serialization failures as retryable', () => {
    expect(isRetryableDbError(failure('40P01'))).toBe(true);
    expect(isRetryableDbError(failure('40001'))).toBe(true);
    expect(isRetryableDbError(failure('55P03'))).toBe(false);
    expect(isRetryableDbError({ code: '40P01' })).toBe(false);
  });
});
