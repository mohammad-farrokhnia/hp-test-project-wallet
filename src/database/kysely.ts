import {
  CompiledQuery,
  DatabaseConnection,
  Dialect,
  Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  QueryResult,
} from 'kysely';
import { QueryRunner } from 'typeorm';
import type { DB } from './db.types';
import { Tx } from './transaction-runner';

/**
 * @class TxConnection
 * @description Runs Kysely's compiled SQL on the QueryRunner of an open TypeORM transaction. Uses the structured result so every statement returns `{ records, affected }` (raw `query()` returns `[rows, affected]` for UPDATE and DELETE).
 */
class TxConnection implements DatabaseConnection {
  constructor(private readonly qr: QueryRunner) {}

  async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
    const res = await this.qr.query(q.sql, [...q.parameters], true);
    return {
      rows: res.records as R[],
      numAffectedRows:
        res.affected === undefined || res.affected === null
          ? undefined
          : BigInt(res.affected),
    };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streaming is not supported on a transaction connection');
  }
}

const notHere = (): Promise<never> =>
  Promise.reject(
    new Error(
      'Transactions belong to TransactionRunner: call db(tx) inside runner.run()',
    ),
  );

/**
 * @class TxDriver
 * @description A Kysely driver with exactly one connection: the caller's transaction. Begin, commit and rollback are refused, so lock and statement timeouts and deadlock retries stay with TransactionRunner.
 */
class TxDriver implements Driver {
  private readonly conn: TxConnection;

  constructor(qr: QueryRunner) {
    this.conn = new TxConnection(qr);
  }

  init(): Promise<void> {
    return Promise.resolve();
  }
  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(this.conn);
  }
  releaseConnection(): Promise<void> {
    return Promise.resolve();
  }
  destroy(): Promise<void> {
    return Promise.resolve();
  }
  beginTransaction = notHere;
  commitTransaction = notHere;
  rollbackTransaction = notHere;
}

class TxDialect implements Dialect {
  constructor(private readonly qr: QueryRunner) {}

  createDriver(): Driver {
    return new TxDriver(this.qr);
  }
  createQueryCompiler(): PostgresQueryCompiler {
    return new PostgresQueryCompiler();
  }
  createAdapter(): PostgresAdapter {
    return new PostgresAdapter();
  }
  createIntrospector(db: Kysely<any>): PostgresIntrospector {
    return new PostgresIntrospector(db);
  }
}

const cache = new WeakMap<QueryRunner, Kysely<DB>>();

/**
 * @function db
 * @description Typed query builder bound to the caller's transaction: table and column names autocomplete and are checked at compile time, and results are typed from `db.types.ts` (regenerate with `npm run db:types`).
 * @param tx - the transaction from `TransactionRunner.run`
 * @returns a Kysely instance whose queries run inside `tx`
 */
export function db(tx: Tx): Kysely<DB> {
  const qr = tx.queryRunner;
  if (!qr) {
    throw new Error('db(tx) needs a transaction: call it inside runner.run()');
  }
  let k = cache.get(qr);
  if (!k) {
    k = new Kysely<DB>({ dialect: new TxDialect(qr) });
    cache.set(qr, k);
  }
  return k;
}
