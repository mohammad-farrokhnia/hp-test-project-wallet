import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * @class InboxNotifications1794729600000
 * @description The consumer side of balance events.
 * - `inbox` (messaging): `(consumer, message_id)` is the primary key. A consumer inserts its message id in the same transaction as its effect,
 *   so a duplicate delivery hits the key and is skipped: delivery is at least once, the effect is exactly once.
 * - `notifications` (notification module): the effect of a balance event, one row per message (`UNIQUE (message_id)` backs the inbox up).
 *   It holds the balances as they were read when the message was handled, never amounts taken from the message.
 */
export class InboxNotifications1794729600000 implements MigrationInterface {
  name = 'InboxNotifications1794729600000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE inbox (
        consumer      text NOT NULL,
        message_id    text NOT NULL,
        processed_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (consumer, message_id),
        CONSTRAINT inbox_consumer_not_empty CHECK (consumer <> ''),
        CONSTRAINT inbox_message_id_not_empty CHECK (message_id <> '')
      )
    `);
    await qr.query(
      'CREATE INDEX inbox_processed_at_idx ON inbox (processed_at)',
    );
    await qr.query(`
      CREATE TABLE notifications (
        id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        message_id       text   NOT NULL,
        user_id          text   NOT NULL,
        kind             text   NOT NULL,
        currency         text   NOT NULL,
        journal_id       bigint NOT NULL,
        available_minor  bigint NOT NULL,
        frozen_minor     bigint NOT NULL,
        debt_minor       bigint NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT notifications_message_key UNIQUE (message_id),
        CONSTRAINT notifications_kind_check CHECK (kind IN ('BALANCE_CHANGED')),
        CONSTRAINT notifications_currency_check CHECK (currency IN ('IRR', 'USDT'))
      )
    `);
    await qr.query(
      'CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC)',
    );
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP TABLE notifications');
    await qr.query('DROP TABLE inbox');
  }
}
