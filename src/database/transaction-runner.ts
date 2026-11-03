import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';

export type Tx = EntityManager;

export interface TransactionRunnerOptions {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  retryBackoffMs?: number;
}

export interface RunOptions {
  retries?: number;
}

const DEADLOCK_DETECTED = '40P01';
const SERIALIZATION_FAILURE = '40001';

export function isRetryableDbError(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const code = (err.driverError as { code?: string } | undefined)?.code;
  return code === DEADLOCK_DETECTED || code === SERIALIZATION_FAILURE;
}

export class TransactionRunner {
  constructor(
    private readonly ds: DataSource,
    private readonly opts: TransactionRunnerOptions,
  ) {}

  async run<T>(
    fn: (tx: Tx) => Promise<T>,
    { retries = 3 }: RunOptions = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(fn);
      } catch (err) {
        if (attempt >= retries || !isRetryableDbError(err)) throw err;
        await sleep(this.backoff(attempt));
      }
    }
  }

  private attempt<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.ds.transaction('READ COMMITTED', async (tx) => {
      await tx.query(
        `SELECT set_config('lock_timeout', $1, true),
                set_config('statement_timeout', $2, true)`,
        [`${this.opts.lockTimeoutMs}ms`, `${this.opts.statementTimeoutMs}ms`],
      );
      return fn(tx);
    });
  }

  private backoff(attempt: number): number {
    const base = this.opts.retryBackoffMs ?? 20;
    return base * (attempt + 1) * (0.5 + Math.random());
  }
}
