import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * @class Transfers1794643200000
 * @description `transfers` (transfer module): one row per wallet-to-wallet transfer, tied one-to-one to its `TRANSFER` journal.
 * The ledger already guarantees the money (zero-sum journal, `CHECK (balance >= 0)`); the constraints here make an impossible
 * transfer row unrepresentable too: no self-transfer, a positive amount, valid user ids, one journal per transfer.
 */
export class Transfers1794643200000 implements MigrationInterface {
  name = 'Transfers1794643200000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE transfers (
        id            uuid   PRIMARY KEY,
        from_user_id  text   NOT NULL,
        to_user_id    text   NOT NULL,
        currency      text   NOT NULL,
        amount_minor  bigint NOT NULL,
        journal_id    bigint NOT NULL REFERENCES journals (id),
        created_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT transfers_journal_key UNIQUE (journal_id),
        CONSTRAINT transfers_currency_check CHECK (currency IN ('IRR', 'USDT')),
        CONSTRAINT transfers_amount_positive CHECK (amount_minor > 0),
        CONSTRAINT transfers_different_users CHECK (from_user_id <> to_user_id),
        CONSTRAINT transfers_user_ids_format CHECK (
          from_user_id ~ '^[A-Za-z0-9_-]{1,64}$' AND to_user_id ~ '^[A-Za-z0-9_-]{1,64}$'
        )
      )
    `);
    await qr.query(
      'CREATE INDEX transfers_from_idx ON transfers (from_user_id, created_at DESC)',
    );
    await qr.query(
      'CREATE INDEX transfers_to_idx ON transfers (to_user_id, created_at DESC)',
    );
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP TABLE transfers');
  }
}
