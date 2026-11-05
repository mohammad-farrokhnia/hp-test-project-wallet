import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * @class DepositsDuplicateRefReview1794556800000
 * @description Adds the review reason `DUPLICATE_REF`: the PSP verified a payment with a bank reference that already credited another deposit.
 * `UNIQUE (psp_ref_id)` refuses the second credit; the deposit is flagged for a person instead of failing its job forever.
 */
export class DepositsDuplicateRefReview1794556800000 implements MigrationInterface {
  name = 'DepositsDuplicateRefReview1794556800000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(
      'ALTER TABLE deposits DROP CONSTRAINT deposits_review_reason_check',
    );
    await qr.query(`
      ALTER TABLE deposits ADD CONSTRAINT deposits_review_reason_check CHECK (
        review_reason IN ('AMOUNT_DIFFERS', 'UNVERIFIED_TOO_LONG', 'LATE_PAYMENT_AFTER_EXPIRY', 'UNKNOWN_TOKEN', 'DUPLICATE_REF')
      )
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(
      `UPDATE deposits SET review_reason = 'UNKNOWN_TOKEN' WHERE review_reason = 'DUPLICATE_REF'`,
    );
    await qr.query(
      'ALTER TABLE deposits DROP CONSTRAINT deposits_review_reason_check',
    );
    await qr.query(`
      ALTER TABLE deposits ADD CONSTRAINT deposits_review_reason_check CHECK (
        review_reason IN ('AMOUNT_DIFFERS', 'UNVERIFIED_TOO_LONG', 'LATE_PAYMENT_AFTER_EXPIRY', 'UNKNOWN_TOKEN')
      )
    `);
  }
}
