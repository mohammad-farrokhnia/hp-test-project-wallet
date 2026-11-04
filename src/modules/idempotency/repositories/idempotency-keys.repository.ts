import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';
import { ResourceRef, StoredResponse } from '../idempotency.types';

export interface KeyRow {
  readonly fingerprint: string;
  readonly status: 'IN_PROGRESS' | 'COMPLETED';
  readonly response: StoredResponse | null;
  readonly resource: ResourceRef | null;
  readonly leaseFree: boolean;
}

/** `locked_until` from the database clock, so instances with drifting clocks agree. */
const leaseUntil = (seconds: number) =>
  sql<Date>`now() + make_interval(secs => ${seconds})`;

/**
 * @class IdempotencyKeysRepository
 * @description Explicit SQL over `idempotency_keys`. Owned by the idempotency module.
 */
@Injectable()
export class IdempotencyKeysRepository {
  /**
   * @function insertClaim
   * @description Inserts the key as `IN_PROGRESS` unless it exists. If a twin inserted it and has not committed, this statement waits for that transaction (bounded by `lock_timeout`), then skips.
   * @param leaseSeconds - set `locked_until` (deposit create); omit for single-transaction endpoints
   * @returns true when this call inserted the key
   */
  async insertClaim(
    tx: Tx,
    row: { key: string; scope: string; fingerprint: string },
    leaseSeconds?: number,
  ): Promise<boolean> {
    const inserted = await db(tx)
      .insertInto('idempotency_keys')
      .values({
        key: row.key,
        scope: row.scope,
        fingerprint: row.fingerprint,
        status: 'IN_PROGRESS',
        locked_until:
          leaseSeconds === undefined ? null : leaseUntil(leaseSeconds),
      })
      .onConflict((oc) => oc.column('key').doNothing())
      .returning('key')
      .executeTakeFirst();
    return inserted !== undefined;
  }

  /**
   * @function lockKey
   * @description Reads the key under a row lock, so a lease renewal or completion can't race another request.
   * @returns the key, or `null` if it does not exist
   */
  async lockKey(tx: Tx, key: string): Promise<KeyRow | null> {
    const row = await db(tx)
      .selectFrom('idempotency_keys')
      .select([
        'fingerprint',
        'status',
        'response_status',
        'response_body',
        'resource_type',
        'resource_id',
      ])
      .select(
        sql<boolean>`locked_until IS NULL OR locked_until <= now()`.as(
          'lease_free',
        ),
      )
      .where('key', '=', key)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return null;
    return {
      fingerprint: row.fingerprint,
      status: row.status as KeyRow['status'],
      response:
        row.response_status === null
          ? null
          : { status: row.response_status, body: row.response_body },
      resource:
        row.resource_type === null || row.resource_id === null
          ? null
          : { type: row.resource_type, id: row.resource_id },
      leaseFree: row.lease_free,
    };
  }

  /** Takes the lease again for `seconds`. */
  async renewLease(tx: Tx, key: string, seconds: number): Promise<void> {
    await db(tx)
      .updateTable('idempotency_keys')
      .set({ locked_until: leaseUntil(seconds) })
      .where('key', '=', key)
      .execute();
  }

  /** Ends the lease now, so the next retry resumes at once. */
  async releaseLease(tx: Tx, key: string): Promise<void> {
    await db(tx)
      .updateTable('idempotency_keys')
      .set({ locked_until: sql<Date>`now()` })
      .where('key', '=', key)
      .where('status', '=', 'IN_PROGRESS')
      .execute();
  }

  /** Records the record the request created. */
  async attachResource(
    tx: Tx,
    key: string,
    resource: ResourceRef,
  ): Promise<void> {
    await db(tx)
      .updateTable('idempotency_keys')
      .set({ resource_type: resource.type, resource_id: resource.id })
      .where('key', '=', key)
      .execute();
  }

  /**
   * @function complete
   * @description Stores the response and marks the key `COMPLETED`. The body is stored as JSON text, so a replay is exactly what was sent.
   * @returns true when an `IN_PROGRESS` key was completed
   */
  async complete(
    tx: Tx,
    key: string,
    response: StoredResponse,
    resource?: ResourceRef,
  ): Promise<boolean> {
    const res = await db(tx)
      .updateTable('idempotency_keys')
      .set({
        status: 'COMPLETED',
        response_status: response.status,
        response_body: JSON.stringify(response.body),
        completed_at: sql<Date>`now()`,
        locked_until: null,
        ...(resource
          ? { resource_type: resource.type, resource_id: resource.id }
          : {}),
      })
      .where('key', '=', key)
      .where('status', '=', 'IN_PROGRESS')
      .executeTakeFirst();
    return res.numUpdatedRows === 1n;
  }
}
