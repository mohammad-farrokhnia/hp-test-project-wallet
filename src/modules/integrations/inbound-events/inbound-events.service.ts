import { Injectable } from '@nestjs/common';
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

/**
 * @class InboundEvents
 * @description Records every callback and webhook as received, rejected ones too:
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
        event_id: e.eventId,
        reference: e.reference,
        signature_valid: e.signatureValid,
        headers: JSON.stringify(e.headers),
        raw_body: e.rawBody,
        outcome: e.outcome,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return BigInt(row.id);
  }
}
