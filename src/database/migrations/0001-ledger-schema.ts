import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * @class LedgerSchema1793779200000
 * @description
 * - `accounts`: one row per bucket of money, balance materialised, overdraft refused by CHECK.
 * - `journals` and `postings`: append-only; every journal sums to zero and has at least two postings, checked by deferred constraint triggers at commit.
 * - the four system accounts are seeded for both currencies.
 */
export class LedgerSchema1793779200000 implements MigrationInterface {
  name = 'LedgerSchema1793779200000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE FUNCTION touch_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END
      $$
    `);

    await qr.query(`
      CREATE FUNCTION reject_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% on % is not allowed: history is append-only', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'restrict_violation';
      END
      $$
    `);

    await qr.query(`
      CREATE TABLE accounts (
        id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner_type      text    NOT NULL,
        user_id         text,
        kind            text    NOT NULL,
        currency        text    NOT NULL,
        balance_minor   bigint  NOT NULL DEFAULT 0,
        allow_negative  boolean GENERATED ALWAYS AS (owner_type = 'SYSTEM' OR kind = 'DEBT') STORED,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT accounts_owner_type_check CHECK (owner_type IN ('USER', 'SYSTEM')),
        CONSTRAINT accounts_currency_check CHECK (currency IN ('IRR', 'USDT')),
        CONSTRAINT accounts_user_id_format CHECK (user_id IS NULL OR user_id ~ '^[A-Za-z0-9_-]{1,64}$'),
        CONSTRAINT accounts_owner_user_id_check CHECK ((owner_type = 'USER') = (user_id IS NOT NULL)),
        CONSTRAINT accounts_owner_kind_check CHECK (
          (owner_type = 'USER' AND kind IN ('AVAILABLE', 'FROZEN', 'DEBT'))
          OR (owner_type = 'SYSTEM' AND kind IN ('PSP_CLEARING', 'PAYOUT_CLEARING', 'FEE_REVENUE', 'OPS_ADJUSTMENTS'))
        ),
        CONSTRAINT accounts_no_overdraft CHECK (allow_negative OR balance_minor >= 0),
        CONSTRAINT accounts_debt_not_positive CHECK (kind <> 'DEBT' OR balance_minor <= 0),
        CONSTRAINT accounts_owner_key UNIQUE NULLS NOT DISTINCT (user_id, kind, currency),
        CONSTRAINT accounts_id_kind_currency_key UNIQUE (id, kind, currency),
        CONSTRAINT accounts_id_user_id_key UNIQUE (id, user_id)
      ) WITH (fillfactor = 90)
    `);

    await qr.query(`
      CREATE TRIGGER accounts_touch_updated_at
        BEFORE UPDATE ON accounts
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
    `);

    await qr.query(`
      INSERT INTO accounts (owner_type, kind, currency)
      SELECT 'SYSTEM', k.kind, c.currency
      FROM unnest(ARRAY['PSP_CLEARING', 'PAYOUT_CLEARING', 'FEE_REVENUE', 'OPS_ADJUSTMENTS']) AS k(kind)
      CROSS JOIN unnest(ARRAY['IRR', 'USDT']) AS c(currency)
    `);

    await qr.query(`
      CREATE TABLE journals (
        id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        kind                 text   NOT NULL,
        ref_type             text   NOT NULL,
        ref_id               uuid   NOT NULL,
        currency             text   NOT NULL,
        reverses_journal_id  bigint REFERENCES journals (id),
        description          text,
        created_at           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT journals_kind_check CHECK (kind IN (
          'DEPOSIT_CREDIT', 'ADJUSTMENT_CREDIT', 'WITHDRAWAL_FREEZE', 'WITHDRAWAL_SETTLE',
          'WITHDRAWAL_RELEASE', 'WITHDRAWAL_RETURN', 'WITHDRAWAL_LATE_SUCCESS', 'TRANSFER'
        )),
        CONSTRAINT journals_ref_type_check CHECK (ref_type IN ('DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT', 'TRANSFER')),
        CONSTRAINT journals_kind_ref_type_check CHECK (ref_type = CASE
          WHEN kind = 'DEPOSIT_CREDIT' THEN 'DEPOSIT'
          WHEN kind = 'ADJUSTMENT_CREDIT' THEN 'ADJUSTMENT'
          WHEN kind = 'TRANSFER' THEN 'TRANSFER'
          ELSE 'WITHDRAWAL'
        END),
        CONSTRAINT journals_currency_check CHECK (currency IN ('IRR', 'USDT')),
        CONSTRAINT journals_kind_ref_key UNIQUE (kind, ref_type, ref_id)
      )
    `);

    await qr.query(`
      CREATE UNIQUE INDEX journals_withdrawal_final_key
        ON journals (ref_id)
        WHERE kind IN ('WITHDRAWAL_SETTLE', 'WITHDRAWAL_RELEASE')
    `);

    await qr.query(`
      CREATE TABLE postings (
        id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        journal_id           bigint NOT NULL REFERENCES journals (id),
        account_id           bigint NOT NULL,
        user_id              text,
        account_kind         text   NOT NULL,
        currency             text   NOT NULL,
        amount_minor         bigint NOT NULL,
        balance_after_minor  bigint NOT NULL,
        created_at           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT postings_amount_nonzero CHECK (amount_minor <> 0),
        CONSTRAINT postings_currency_check CHECK (currency IN ('IRR', 'USDT')),
        CONSTRAINT postings_user_id_matches_kind CHECK (
          (user_id IS NULL) = (account_kind IN ('PSP_CLEARING', 'PAYOUT_CLEARING', 'FEE_REVENUE', 'OPS_ADJUSTMENTS'))
        ),
        CONSTRAINT postings_account_fkey FOREIGN KEY (account_id, account_kind, currency)
          REFERENCES accounts (id, kind, currency),
        CONSTRAINT postings_account_user_fkey FOREIGN KEY (account_id, user_id)
          REFERENCES accounts (id, user_id)
      )
    `);

    await qr.query(
      `CREATE INDEX postings_user_history_idx ON postings (user_id, id DESC) WHERE user_id IS NOT NULL`,
    );
    await qr.query(
      `CREATE INDEX postings_account_idx ON postings (account_id, id DESC)`,
    );
    await qr.query(
      `CREATE INDEX postings_journal_idx ON postings (journal_id)`,
    );

    await qr.query(`
      CREATE FUNCTION check_journal_balanced() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        v_sum numeric;
        v_foreign_currency bigint;
      BEGIN
        SELECT COALESCE(sum(p.amount_minor), 0),
               count(*) FILTER (WHERE p.currency <> j.currency)
          INTO v_sum, v_foreign_currency
          FROM postings p
          JOIN journals j ON j.id = p.journal_id
         WHERE p.journal_id = NEW.journal_id;

        IF v_sum <> 0 THEN
          RAISE EXCEPTION 'journal % is unbalanced: postings sum to %', NEW.journal_id, v_sum
            USING ERRCODE = 'check_violation';
        END IF;
        IF v_foreign_currency > 0 THEN
          RAISE EXCEPTION 'journal % has postings in a currency other than its own', NEW.journal_id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END
      $$
    `);

    await qr.query(`
      CREATE FUNCTION check_journal_has_postings() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT count(*) FROM postings WHERE journal_id = NEW.id) < 2 THEN
          RAISE EXCEPTION 'journal % needs at least two postings', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END
      $$
    `);

    await qr.query(`
      CREATE CONSTRAINT TRIGGER postings_balanced
        AFTER INSERT ON postings
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION check_journal_balanced()
    `);

    await qr.query(`
      CREATE CONSTRAINT TRIGGER journals_have_postings
        AFTER INSERT ON journals
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION check_journal_has_postings()
    `);

    await qr.query(`
      CREATE TRIGGER journals_immutable
        BEFORE UPDATE OR DELETE ON journals
        FOR EACH ROW EXECUTE FUNCTION reject_mutation()
    `);

    await qr.query(`
      CREATE TRIGGER postings_immutable
        BEFORE UPDATE OR DELETE ON postings
        FOR EACH ROW EXECUTE FUNCTION reject_mutation()
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP TABLE postings');
    await qr.query('DROP TABLE journals');
    await qr.query('DROP TABLE accounts');
    await qr.query('DROP FUNCTION check_journal_has_postings()');
    await qr.query('DROP FUNCTION check_journal_balanced()');
    await qr.query('DROP FUNCTION reject_mutation()');
    await qr.query('DROP FUNCTION touch_updated_at()');
  }
}
