import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';

/** An outbox row the relay has claimed. */
export interface ClaimedRow {
  readonly id: bigint;
  readonly exchange: string;
  readonly routingKey: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, string>>;
  readonly createdAt: Date;
}

/** A failed row stays claimed this long, doubling per attempt, at most 10 minutes. */
const MAX_BACKOFF_SECONDS = 600;

/**
 * @class OutboxRepository
 * @description Explicit SQL over `outbox`. Owned by the messaging module.
 */
@Injectable()
export class OutboxRepository {
  /**
   * @function insert
   * @returns the new row's id, which is also the message id
   */
  async insert(
    tx: Tx,
    row: {
      exchange: string;
      routingKey: string;
      aggregateType: string;
      aggregateId: string;
      payload: Readonly<Record<string, string>>;
    },
  ): Promise<bigint> {
    const inserted = await db(tx)
      .insertInto('outbox')
      .values({
        exchange: row.exchange,
        routing_key: row.routingKey,
        aggregate_type: row.aggregateType,
        aggregate_id: row.aggregateId,
        payload: JSON.stringify(row.payload),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return BigInt(inserted.id);
  }

  /**
   * @function claimBatch
   * @description Claims up to `limit` unsent rows, oldest first: rows never claimed, or whose claim expired.
   * `FOR UPDATE SKIP LOCKED` lets relays claim at the same moment without waiting for or overlapping each other;
   * the claim itself (`claimed_until`) keeps them apart after this transaction commits. Walks `outbox_unsent_idx`.
   * @param tx - a short transaction of its own; commit before publishing
   * @param limit - batch size
   * @param claimSeconds - how long the claim lasts
   * @returns the claimed rows, by id
   */
  async claimBatch(
    tx: Tx,
    limit: number,
    claimSeconds: number,
  ): Promise<ClaimedRow[]> {
    const { rows } = await sql<{
      id: string;
      exchange: string;
      routing_key: string;
      aggregate_type: string;
      aggregate_id: string;
      payload: Record<string, string>;
      created_at: Date;
    }>`
      UPDATE outbox o
         SET claimed_until = now() + make_interval(secs => ${claimSeconds}),
             attempts = o.attempts + 1
        FROM (SELECT id FROM outbox
               WHERE published_at IS NULL
                 AND (claimed_until IS NULL OR claimed_until <= now())
               ORDER BY id
               LIMIT ${limit}
                 FOR UPDATE SKIP LOCKED) due
       WHERE o.id = due.id
      RETURNING o.id::text, o.exchange, o.routing_key, o.aggregate_type,
                o.aggregate_id, o.payload, o.created_at`.execute(db(tx));

    return rows
      .map((r) => ({
        id: BigInt(r.id),
        exchange: r.exchange,
        routingKey: r.routing_key,
        aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id,
        payload: r.payload,
        createdAt: r.created_at,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Marks rows sent; a row already marked (a republish after a crash) is left as it is. */
  async markPublished(tx: Tx, ids: readonly bigint[]): Promise<void> {
    if (ids.length === 0) return;
    await db(tx)
      .updateTable('outbox')
      .set({
        published_at: sql<Date>`now()`,
        claimed_until: null,
        last_error: null,
      })
      .where(
        'id',
        'in',
        ids.map((id) => id.toString()),
      )
      .where('published_at', 'is', null)
      .execute();
  }

  /**
   * @function recordFailure
   * @description Keeps the row unsent, stores the error, and holds the claim for a backoff (`claimSeconds × 2^(attempts − 1)`,
   * at most 10 minutes), so a row that keeps failing, such as an unroutable one, is not hammered.
   */
  async recordFailure(
    tx: Tx,
    id: bigint,
    error: string,
    claimSeconds: number,
  ): Promise<void> {
    await db(tx)
      .updateTable('outbox')
      .set({
        last_error: error.slice(0, 1000),
        claimed_until: sql<Date>`now() + make_interval(secs => least(
          ${claimSeconds}::float8 * power(2, greatest(attempts - 1, 0)),
          ${MAX_BACKOFF_SECONDS}::float8))`,
      })
      .where('id', '=', id.toString())
      .where('published_at', 'is', null)
      .execute();
  }

  /**
   * @function deletePublishedOlderThan
   * @description Deletes up to `limit` rows published more than `days` ago, oldest first. Unsent rows are never touched.
   * `SKIP LOCKED` lets two workers purge at once without waiting on each other.
   * @returns how many rows were deleted
   */
  async deletePublishedOlderThan(
    tx: Tx,
    days: number,
    limit: number,
  ): Promise<number> {
    const { rows } = await sql<{ id: string }>`
      WITH doomed AS (
        SELECT id FROM outbox
         WHERE published_at IS NOT NULL
           AND published_at < now() - make_interval(days => ${days})
         ORDER BY published_at
         LIMIT ${limit}
           FOR UPDATE SKIP LOCKED
      )
      DELETE FROM outbox o
       USING doomed
       WHERE o.id = doomed.id
      RETURNING o.id`.execute(db(tx));
    return rows.length;
  }
}
