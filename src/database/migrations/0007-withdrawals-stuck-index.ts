import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * @class WithdrawalsStuckIndex1794297600000
 * @description The review sweep's work queue: open withdrawals not yet flagged, by age.
 * Partial, so it holds only the few rows still in flight; finished and flagged rows drop out.
 */
export class WithdrawalsStuckIndex1794297600000 implements MigrationInterface {
  name = 'WithdrawalsStuckIndex1794297600000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE INDEX withdrawals_unflagged_open_idx ON withdrawals (created_at)
        WHERE status IN ('PENDING', 'SUBMITTING', 'PROCESSING') AND NOT needs_review
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP INDEX withdrawals_unflagged_open_idx');
  }
}
