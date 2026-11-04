import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * @class Adjustments1793952000000
 * @description `adjustments` (operations module): one manual credit by an operator, booked as exactly one `ADJUSTMENT_CREDIT` journal (`journal_id` is unique). Increases only.
 */
export class Adjustments1793952000000 implements MigrationInterface {
  name = 'Adjustments1793952000000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE adjustments (
        id            uuid   PRIMARY KEY,
        user_id       text   NOT NULL,
        currency      text   NOT NULL,
        amount_minor  bigint NOT NULL,
        reason        text   NOT NULL,
        actor         text,
        journal_id    bigint NOT NULL REFERENCES journals (id),
        created_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT adjustments_user_id_format CHECK (user_id ~ '^[A-Za-z0-9_-]{1,64}$'),
        CONSTRAINT adjustments_currency_check CHECK (currency IN ('IRR', 'USDT')),
        CONSTRAINT adjustments_amount_positive CHECK (amount_minor > 0),
        CONSTRAINT adjustments_reason_length CHECK (char_length(reason) BETWEEN 3 AND 500),
        CONSTRAINT adjustments_actor_length CHECK (actor IS NULL OR char_length(actor) BETWEEN 1 AND 128),
        CONSTRAINT adjustments_journal_key UNIQUE (journal_id)
      )
    `);
    await qr.query(
      'CREATE INDEX adjustments_user_created_idx ON adjustments (user_id, created_at DESC)',
    );
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP TABLE adjustments');
  }
}
