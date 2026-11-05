import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * @class Withdrawals1794124800000
 * @description
 * - `withdrawals`: one row per request; its id is the payout `requestId`. CHECKs tie status to its
 *   timestamps and reasons, so even a buggy code path can't write an impossible withdrawal.
 * - `payout_attempts`: every submit to the payout service, opened before the call.
 * - `withdrawal_daily_usage`: the reserved daily-limit counter per user and Tehran day;
 *   `CHECK (used_rial <= cap_rial)` is the last line of defence for the limit.
 */
export class Withdrawals1794124800000 implements MigrationInterface {
  name = 'Withdrawals1794124800000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE withdrawals (
        id                        uuid   PRIMARY KEY,
        user_id                   text   NOT NULL,
        currency                  text   NOT NULL,
        amount_minor              bigint NOT NULL,
        fee_minor                 bigint NOT NULL DEFAULT 0,
        destination_type          text   NOT NULL,
        destination               text   NOT NULL,
        status                    text   NOT NULL,
        failure_reason            text,
        provider_status           text,
        provider_reason           text,
        provider_tracking_id      text,
        limit_day                 date   NOT NULL,
        limit_amount_rial         bigint NOT NULL,
        limit_rate_rial_per_usdt  bigint,
        submit_attempts           int    NOT NULL DEFAULT 0,
        needs_review              boolean NOT NULL DEFAULT false,
        review_reason             text,
        returned_at               timestamptz,
        return_reason             text,
        late_success_at           timestamptz,
        next_check_at             timestamptz,
        submitted_at              timestamptz,
        completed_at              timestamptz,
        created_at                timestamptz NOT NULL DEFAULT now(),
        updated_at                timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT withdrawals_user_id_format CHECK (user_id ~ '^[A-Za-z0-9_-]{1,64}$'),
        CONSTRAINT withdrawals_currency_check CHECK (currency IN ('IRR', 'USDT')),
        CONSTRAINT withdrawals_amount_positive CHECK (amount_minor > 0),
        CONSTRAINT withdrawals_fee_not_negative CHECK (fee_minor >= 0),
        CONSTRAINT withdrawals_destination_type_matches_currency CHECK (
          destination_type = CASE currency WHEN 'IRR' THEN 'IBAN' ELSE 'TRC20' END
        ),
        CONSTRAINT withdrawals_destination_format CHECK (
          (destination_type = 'IBAN' AND destination ~ '^IR[0-9]{24}$')
          OR (destination_type = 'TRC20' AND destination ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$')
        ),
        CONSTRAINT withdrawals_status_check CHECK (
          status IN ('PENDING', 'SUBMITTING', 'PROCESSING', 'SUCCEEDED', 'FAILED')
        ),
        CONSTRAINT withdrawals_failure_reason_check CHECK (
          failure_reason IN ('PROVIDER_REJECTED', 'PROVIDER_FAILED', 'CANCELLED')
        ),
        CONSTRAINT withdrawals_failure_reason_iff_failed CHECK ((failure_reason IS NOT NULL) = (status = 'FAILED')),
        CONSTRAINT withdrawals_completed_at_iff_final CHECK ((completed_at IS NOT NULL) = (status IN ('SUCCEEDED', 'FAILED'))),
        CONSTRAINT withdrawals_returned_only_succeeded CHECK (returned_at IS NULL OR status = 'SUCCEEDED'),
        CONSTRAINT withdrawals_return_reason_needs_return CHECK (return_reason IS NULL OR returned_at IS NOT NULL),
        CONSTRAINT withdrawals_late_success_only_succeeded CHECK (late_success_at IS NULL OR status = 'SUCCEEDED'),
        CONSTRAINT withdrawals_review_reason_check CHECK (
          review_reason IN ('STUCK', 'REPLAY_MISMATCH', 'LATE_SUCCESS', 'UNKNOWN_AFTER_SUCCESS')
        ),
        CONSTRAINT withdrawals_review_needs_reason CHECK (NOT needs_review OR review_reason IS NOT NULL),
        CONSTRAINT withdrawals_limit_amount_not_negative CHECK (limit_amount_rial >= 0),
        CONSTRAINT withdrawals_limit_rate_usdt_only CHECK (
          limit_rate_rial_per_usdt IS NULL OR (currency = 'USDT' AND limit_rate_rial_per_usdt > 0)
        ),
        CONSTRAINT withdrawals_submit_attempts_not_negative CHECK (submit_attempts >= 0)
      )
    `);
    await qr.query(`
      CREATE TRIGGER withdrawals_touch_updated_at
        BEFORE UPDATE ON withdrawals
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
    `);
    // The sweeper's queue, including SUCCEEDED rows still watched for returns.
    await qr.query(
      'CREATE INDEX withdrawals_next_check_idx ON withdrawals (next_check_at) WHERE next_check_at IS NOT NULL',
    );
    await qr.query(
      'CREATE INDEX withdrawals_user_created_idx ON withdrawals (user_id, created_at DESC)',
    );
    // The review queue.
    await qr.query(
      'CREATE INDEX withdrawals_review_idx ON withdrawals (created_at) WHERE needs_review',
    );

    await qr.query(`
      CREATE TABLE payout_attempts (
        withdrawal_id  uuid   NOT NULL REFERENCES withdrawals (id),
        attempt_no     int    NOT NULL,
        request_body   jsonb  NOT NULL,
        started_at     timestamptz NOT NULL DEFAULT now(),
        finished_at    timestamptz,
        outcome        text,
        http_status    int,
        error          text,
        response_body  jsonb,
        PRIMARY KEY (withdrawal_id, attempt_no),
        CONSTRAINT payout_attempts_attempt_no_positive CHECK (attempt_no >= 1),
        CONSTRAINT payout_attempts_outcome_check CHECK (
          outcome IN ('ACCEPTED', 'REPLAYED', 'REJECTED', 'AMBIGUOUS', 'MISMATCH')
        ),
        CONSTRAINT payout_attempts_finished_iff_outcome CHECK ((finished_at IS NULL) = (outcome IS NULL)),
        CONSTRAINT payout_attempts_http_status_check CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599)
      )
    `);

    await qr.query(`
      CREATE TABLE withdrawal_daily_usage (
        user_id     text   NOT NULL,
        day         date   NOT NULL,
        used_rial   bigint NOT NULL DEFAULT 0,
        cap_rial    bigint NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, day),
        CONSTRAINT withdrawal_daily_usage_cap_positive CHECK (cap_rial > 0),
        CONSTRAINT withdrawal_daily_usage_within_cap CHECK (used_rial >= 0 AND used_rial <= cap_rial)
      )
    `);
    await qr.query(`
      CREATE TRIGGER withdrawal_daily_usage_touch_updated_at
        BEFORE UPDATE ON withdrawal_daily_usage
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP TABLE withdrawal_daily_usage');
    await qr.query('DROP TABLE payout_attempts');
    await qr.query('DROP TABLE withdrawals');
  }
}
