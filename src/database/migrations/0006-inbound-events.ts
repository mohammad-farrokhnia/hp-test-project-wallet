import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * @class InboundEvents1794211200000
 * @description `inbound_events` (integrations): every PSP callback and payout webhook exactly as received, rejected ones included. An audit trail and evidence; correctness never depends on it.
 */
export class InboundEvents1794211200000 implements MigrationInterface {
  name = 'InboundEvents1794211200000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE inbound_events (
        id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        source           text    NOT NULL,
        event_id         text,
        reference        text,
        signature_valid  boolean,
        headers          jsonb   NOT NULL,
        raw_body         text    NOT NULL,
        outcome          text    NOT NULL,
        received_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT inbound_events_source_check CHECK (source IN ('PSP_CALLBACK', 'PAYOUT_WEBHOOK')),
        CONSTRAINT inbound_events_outcome_check CHECK (
          outcome IN ('ACCEPTED', 'REJECTED_SIGNATURE', 'UNKNOWN_REFERENCE', 'MISMATCH', 'IGNORED_FINAL')
        ),
        CONSTRAINT inbound_events_payout_signed CHECK (source <> 'PAYOUT_WEBHOOK' OR signature_valid IS NOT NULL),
        CONSTRAINT inbound_events_rejected_means_invalid CHECK (
          outcome <> 'REJECTED_SIGNATURE' OR signature_valid = false
        )
      )
    `);
    await qr.query(
      'CREATE INDEX inbound_events_reference_idx ON inbound_events (reference, received_at)',
    );
    await qr.query(
      'CREATE INDEX inbound_events_received_at_idx ON inbound_events (received_at)',
    );
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP TABLE inbound_events');
  }
}
