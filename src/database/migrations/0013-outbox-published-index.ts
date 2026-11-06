import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * @class OutboxPublishedIndex1794816000000
 * @description The retention purge's work queue: published outbox rows by when they were published.
 * Partial, so it holds only rows already sent; the relay's own queue (`outbox_unsent_idx`) is the unsent ones.
 */
export class OutboxPublishedIndex1794816000000 implements MigrationInterface {
  name = 'OutboxPublishedIndex1794816000000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      'CREATE INDEX outbox_published_idx ON outbox (published_at) WHERE published_at IS NOT NULL',
    );
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP INDEX outbox_published_idx');
  }
}
