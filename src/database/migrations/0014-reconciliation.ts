import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * @class Reconciliation1794902400000
 * @description Settlement reconciliation (operations module): `reconciliation_runs` keeps each run with the exact file it read,
 * `reconciliation_mismatches` what it found. A run only reads: nothing here references money, and no row is ever updated or deleted by the app.
 * - each mismatch type has the fields it needs, so a mismatch row cannot be half-filled (`AMOUNT_MISMATCH` has both amounts, which differ);
 * - `UNREADABLE_ROW` exists so that a row of the file we cannot read is reported instead of silently skipped.
 * Two indexes serve our side of a run: credited deposits by day, and deposits by bank reference with its zero padding removed
 * (the PSP file pads references to 13 digits).
 */
export class Reconciliation1794902400000 implements MigrationInterface {
  name = 'Reconciliation1794902400000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE reconciliation_runs (
        id               uuid PRIMARY KEY,
        settlement_date  date NOT NULL,
        started_at       timestamptz NOT NULL,
        finished_at      timestamptz NOT NULL,
        settlement_rows  int  NOT NULL,
        matched          int  NOT NULL,
        mismatch_count   int  NOT NULL,
        raw_csv          text NOT NULL,
        CONSTRAINT reconciliation_runs_counts_check CHECK (
          settlement_rows >= 0 AND matched >= 0 AND mismatch_count >= 0 AND matched <= settlement_rows
        ),
        CONSTRAINT reconciliation_runs_finished_after_started CHECK (finished_at >= started_at)
      )
    `);
    await qr.query(
      'CREATE INDEX reconciliation_runs_date_idx ON reconciliation_runs (settlement_date, started_at DESC)',
    );
    await qr.query(`
      CREATE TABLE reconciliation_mismatches (
        id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        run_id            uuid   NOT NULL REFERENCES reconciliation_runs (id),
        type              text   NOT NULL,
        reference         text,
        deposit_id        uuid,
        our_amount_rial   bigint,
        their_amount_rial bigint,
        details           jsonb  NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT reconciliation_mismatches_type_check CHECK (
          type IN ('MISSING_IN_LEDGER', 'MISSING_IN_SETTLEMENT', 'AMOUNT_MISMATCH', 'DUPLICATE_IN_SETTLEMENT', 'UNREADABLE_ROW')
        ),
        CONSTRAINT reconciliation_mismatches_details_object CHECK (jsonb_typeof(details) = 'object'),
        CONSTRAINT reconciliation_mismatches_amounts_positive CHECK (
          (our_amount_rial IS NULL OR our_amount_rial > 0) AND (their_amount_rial IS NULL OR their_amount_rial > 0)
        ),
        CONSTRAINT reconciliation_mismatches_shape CHECK (
          CASE type
            WHEN 'MISSING_IN_LEDGER' THEN reference IS NOT NULL AND their_amount_rial IS NOT NULL AND our_amount_rial IS NULL
            WHEN 'MISSING_IN_SETTLEMENT' THEN reference IS NOT NULL AND deposit_id IS NOT NULL AND our_amount_rial IS NOT NULL AND their_amount_rial IS NULL
            WHEN 'AMOUNT_MISMATCH' THEN reference IS NOT NULL AND deposit_id IS NOT NULL AND our_amount_rial IS NOT NULL AND their_amount_rial IS NOT NULL AND our_amount_rial <> their_amount_rial
            WHEN 'DUPLICATE_IN_SETTLEMENT' THEN reference IS NOT NULL AND their_amount_rial IS NOT NULL
            WHEN 'UNREADABLE_ROW' THEN our_amount_rial IS NULL AND their_amount_rial IS NULL
          END
        )
      )
    `);
    await qr.query(
      'CREATE INDEX reconciliation_mismatches_run_idx ON reconciliation_mismatches (run_id, id)',
    );
    await qr.query(
      `CREATE INDEX deposits_credited_at_idx ON deposits (completed_at) WHERE status = 'SUCCEEDED'`,
    );
    await qr.query(
      `CREATE INDEX deposits_ref_normalized_idx ON deposits ((ltrim(psp_ref_id, '0'))) WHERE psp_ref_id IS NOT NULL`,
    );
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP INDEX deposits_ref_normalized_idx');
    await qr.query('DROP INDEX deposits_credited_at_idx');
    await qr.query('DROP TABLE reconciliation_mismatches');
    await qr.query('DROP TABLE reconciliation_runs');
  }
}
