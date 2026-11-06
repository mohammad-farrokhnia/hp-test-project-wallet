import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';

export type InboundSource = 'PSP_CALLBACK' | 'PAYOUT_WEBHOOK';
export type InboundOutcome =
  | 'ACCEPTED'
  | 'REJECTED_SIGNATURE'
  | 'UNKNOWN_REFERENCE'
  | 'MISMATCH'
  | 'IGNORED_FINAL';

export interface InboundEvent {
  readonly source: InboundSource;
  readonly eventId: string | null;
  readonly reference: string | null;
  readonly signatureValid: boolean | null;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly rawBody: string;
  readonly outcome: InboundOutcome;
}

/** The character PostgreSQL `text` cannot store. */
const NUL = '\u0000';

/**
 * @function storable
 * @description Replaces NUL characters with U+FFFD: PostgreSQL refuses them in `text`, and a delivery that carries one must still be recorded, not turn into a 500.
 * Signatures are checked on the raw bytes before this, so nothing that is verified is affected.
 */
function storable(text: string): string {
  return text.split(NUL).join('\uFFFD');
}

/**
 * @class InboundEvents
 * @description Records every callback and webhook as received, rejected ones too (a NUL character, which `text` cannot hold, is stored as U+FFFD):
 * the audit trail and the evidence behind the provider notes. Kept 30 days.
 */
@Injectable()
export class InboundEvents {
  /** @returns the row id */
  async record(tx: Tx, e: InboundEvent): Promise<bigint> {
    const row = await db(tx)
      .insertInto('inbound_events')
      .values({
        source: e.source,
        event_id: e.eventId === null ? null : storable(e.eventId),
        reference: e.reference === null ? null : storable(e.reference),
        signature_valid: e.signatureValid,
        headers: JSON.stringify(e.headers),
        raw_body: storable(e.rawBody),
        outcome: e.outcome,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return BigInt(row.id);
  }

  /**
   * @function deleteOlderThan
   * @description Deletes up to `limit` recorded events received more than `days` ago, oldest first; `SKIP LOCKED` as for every purge.
   * @returns how many rows were deleted
   */
  async deleteOlderThan(tx: Tx, days: number, limit: number): Promise<number> {
    const { rows } = await sql<{ id: string }>`
      WITH doomed AS (
        SELECT id FROM inbound_events
         WHERE received_at < now() - make_interval(days => ${days})
         ORDER BY received_at
         LIMIT ${limit}
           FOR UPDATE SKIP LOCKED
      )
      DELETE FROM inbound_events e
       USING doomed
       WHERE e.id = doomed.id
      RETURNING e.id`.execute(db(tx));
    return rows.length;
  }
}
