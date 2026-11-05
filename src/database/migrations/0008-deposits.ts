import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * @class Deposits1794384000000
 * @description `deposits`: one row per top-up attempt; its id is the PSP `orderId`.
 * - `UNIQUE (psp_token)` and `UNIQUE (psp_ref_id)`: one gateway payment can credit at most one deposit
 *   (PostgreSQL allows many NULLs, so unissued tokens and unverified deposits do not collide).
 * - CHECKs tie status to its reasons, timestamps and credited amount, so even a buggy code path
 *   cannot write an impossible deposit.
 * - `next_check_at` partial index is the sweeper's queue; null means nothing to do.
 */
export class Deposits1794384000000 implements MigrationInterface {
  name = 'Deposits1794384000000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE deposits (
        id               uuid   PRIMARY KEY,
        user_id          text   NOT NULL,
        amount_rial      bigint NOT NULL,
        credited_rial    bigint,
        status           text   NOT NULL,
        failure_reason   text,
        psp_token        text,
        payment_url      text,
        psp_status       text,
        psp_ref_id       text,
        paid_seen_at     timestamptz,
        needs_review     boolean NOT NULL DEFAULT false,
        review_reason    text,
        next_check_at    timestamptz,
        check_attempts   int    NOT NULL DEFAULT 0,
        expires_at       timestamptz NOT NULL,
        completed_at     timestamptz,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT deposits_psp_token_key UNIQUE (psp_token),
        CONSTRAINT deposits_psp_ref_id_key UNIQUE (psp_ref_id),
        CONSTRAINT deposits_user_id_format CHECK (user_id ~ '^[A-Za-z0-9_-]{1,64}$'),
        CONSTRAINT deposits_amount_positive CHECK (amount_rial > 0),
        CONSTRAINT deposits_status_check CHECK (status IN ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED')),
        CONSTRAINT deposits_failure_reason_check CHECK (
          failure_reason IN ('PSP_REJECTED', 'PSP_FAILED', 'PSP_REVERSED', 'EXPIRED', 'CREATE_ABANDONED')
        ),
        CONSTRAINT deposits_failure_reason_iff_failed CHECK ((failure_reason IS NOT NULL) = (status = 'FAILED')),
        CONSTRAINT deposits_credited_iff_succeeded CHECK ((credited_rial IS NOT NULL) = (status = 'SUCCEEDED')),
        CONSTRAINT deposits_credited_positive CHECK (credited_rial IS NULL OR credited_rial > 0),
        CONSTRAINT deposits_completed_at_iff_final CHECK ((completed_at IS NOT NULL) = (status IN ('SUCCEEDED', 'FAILED'))),
        CONSTRAINT deposits_token_once_issued CHECK (status NOT IN ('PENDING', 'SUCCEEDED') OR psp_token IS NOT NULL),
        CONSTRAINT deposits_psp_status_check CHECK (
          psp_status IN ('INIT', 'PAID', 'VERIFIED', 'FAILED', 'REVERSED')
        ),
        CONSTRAINT deposits_review_reason_check CHECK (
          review_reason IN ('AMOUNT_DIFFERS', 'UNVERIFIED_TOO_LONG', 'LATE_PAYMENT_AFTER_EXPIRY', 'UNKNOWN_TOKEN')
        ),
        CONSTRAINT deposits_review_needs_reason CHECK (NOT needs_review OR review_reason IS NOT NULL),
        CONSTRAINT deposits_check_attempts_not_negative CHECK (check_attempts >= 0),
        CONSTRAINT deposits_expires_after_creation CHECK (expires_at > created_at)
      )
    `);
    await qr.query(`
      CREATE TRIGGER deposits_touch_updated_at
        BEFORE UPDATE ON deposits
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
    `);
    await qr.query(
      'CREATE INDEX deposits_next_check_idx ON deposits (next_check_at) WHERE next_check_at IS NOT NULL',
    );
    await qr.query(
      'CREATE INDEX deposits_user_created_idx ON deposits (user_id, created_at DESC)',
    );
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP TABLE deposits');
  }
}
