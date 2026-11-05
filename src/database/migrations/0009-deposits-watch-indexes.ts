import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * @class DepositsWatchIndexes1794470400000
 * @description The deposit watchdog's two work queues, both partial so they hold only the few rows still in flight:
 * - `CREATED` deposits by age (abandoned creates);
 * - `PENDING` deposits seen paid but not yet flagged, by when they were first seen paid (the unverified alert).
 */
export class DepositsWatchIndexes1794470400000 implements MigrationInterface {
  name = 'DepositsWatchIndexes1794470400000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      `CREATE INDEX deposits_created_idx ON deposits (created_at) WHERE status = 'CREATED'`,
    );
    await qr.query(`
      CREATE INDEX deposits_unverified_idx ON deposits (paid_seen_at)
        WHERE status = 'PENDING' AND paid_seen_at IS NOT NULL AND NOT needs_review
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP INDEX deposits_unverified_idx');
    await qr.query('DROP INDEX deposits_created_idx');
  }
}
