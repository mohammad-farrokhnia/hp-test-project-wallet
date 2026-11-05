import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * @class Outbox1794038400000
 * @description `outbox`: a message written in the same transaction as the business change, so the job exists exactly when the change committed.
 */
export class Outbox1794038400000 implements MigrationInterface {
  name = 'Outbox1794038400000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE outbox (
        id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        exchange        text   NOT NULL,
        routing_key     text   NOT NULL,
        aggregate_type  text   NOT NULL,
        aggregate_id    text   NOT NULL,
        payload         jsonb  NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        claimed_until   timestamptz,
        published_at    timestamptz,
        attempts        int    NOT NULL DEFAULT 0,
        last_error      text,
        CONSTRAINT outbox_exchange_check CHECK (exchange IN ('wallet.jobs', 'wallet.events')),
        CONSTRAINT outbox_routing_key_check CHECK (char_length(routing_key) BETWEEN 1 AND 255),
        CONSTRAINT outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
        CONSTRAINT outbox_attempts_check CHECK (attempts >= 0)
      )
    `);
    await qr.query(
      'CREATE INDEX outbox_unsent_idx ON outbox (id) WHERE published_at IS NULL',
    );
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP TABLE outbox');
  }
}
