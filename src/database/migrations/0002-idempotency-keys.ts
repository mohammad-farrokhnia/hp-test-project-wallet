import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * @class IdempotencyKeys1793865600000
 * @description one row per Idempotency-Key, inserted in the same transaction as the effect and its stored response.
 * - `key` is global: the fingerprint covers the scope, so one key used on two routes is a reuse.
 * - `response_body` is `json`, not `jsonb`
 * - `locked_until` is the lease, used only by the two-phase deposit create.
 */
export class IdempotencyKeys1793865600000 implements MigrationInterface {
  name = 'IdempotencyKeys1793865600000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE idempotency_keys (
        key              text PRIMARY KEY,
        scope            text   NOT NULL,
        fingerprint      text   NOT NULL,
        status           text   NOT NULL,
        response_status  int,
        response_body    json,
        resource_type    text,
        resource_id      uuid,
        locked_until     timestamptz,
        created_at       timestamptz NOT NULL DEFAULT now(),
        completed_at     timestamptz,
        CONSTRAINT idempotency_keys_key_format CHECK (key ~ '^[ -~]{1,255}$'),
        CONSTRAINT idempotency_keys_status_check CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
        CONSTRAINT idempotency_keys_completed_has_response CHECK (
          status <> 'COMPLETED' OR (response_status IS NOT NULL AND response_body IS NOT NULL)
        ),
        CONSTRAINT idempotency_keys_completed_at_check CHECK ((completed_at IS NOT NULL) = (status = 'COMPLETED')),
        CONSTRAINT idempotency_keys_response_status_check CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
        CONSTRAINT idempotency_keys_resource_check CHECK ((resource_type IS NULL) = (resource_id IS NULL))
      )
    `);
    // The 7-day cleanup
    await qr.query(
      'CREATE INDEX idempotency_keys_created_at_idx ON idempotency_keys (created_at)',
    );
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP TABLE idempotency_keys');
  }
}
