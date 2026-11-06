import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { storable } from '../../../common/strings';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';
import type { Mismatch, MismatchType } from './reconcile';

export interface NewRun {
  readonly id: string;
  readonly settlementDate: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly settlementRows: number;
  readonly matched: number;
  readonly mismatches: readonly Mismatch[];
  readonly rawCsv: string;
}

export interface RunRecord {
  readonly id: string;
  readonly settlementDate: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly settlementRows: number;
  readonly matched: number;
  readonly mismatchCount: number;
}

/** Mismatches per INSERT: 1,000 rows of 7 parameters, far below PostgreSQL's limit. */
const MISMATCH_BATCH = 1000;

/**
 * @class ReconciliationRepository
 * @description Explicit SQL over `reconciliation_runs` and `reconciliation_mismatches`. Owned by the operations module.
 * Insert and read only: a run is a record of what was found, never edited.
 */
@Injectable()
export class ReconciliationRepository {
  /**
   * Stores a run, the exact file it read, and every mismatch it found, in the caller's transaction.
   * Text taken from the file goes through `storable`: PostgreSQL's `text` and `jsonb` both refuse a NUL character.
   */
  async insertRun(tx: Tx, run: NewRun): Promise<void> {
    await db(tx)
      .insertInto('reconciliation_runs')
      .values({
        id: run.id,
        settlement_date: run.settlementDate,
        started_at: run.startedAt,
        finished_at: run.finishedAt,
        settlement_rows: run.settlementRows,
        matched: run.matched,
        mismatch_count: run.mismatches.length,
        raw_csv: run.rawCsv,
      })
      .execute();
    for (let i = 0; i < run.mismatches.length; i += MISMATCH_BATCH) {
      await this.insertMismatches(
        tx,
        run.id,
        run.mismatches.slice(i, i + MISMATCH_BATCH),
      );
    }
  }

  /** One statement for a batch: PostgreSQL allows 65,535 parameters in one, and a file can hold far more mismatches than the 9,000 that fit. */
  private async insertMismatches(
    tx: Tx,
    runId: string,
    mismatches: readonly Mismatch[],
  ): Promise<void> {
    await db(tx)
      .insertInto('reconciliation_mismatches')
      .values(
        mismatches.map((m) => ({
          run_id: runId,
          type: m.type,
          reference: m.reference,
          deposit_id: m.depositId,
          our_amount_rial: m.ourAmountRial,
          their_amount_rial: m.theirAmountRial,
          details: JSON.stringify(m.details, (_key, value: unknown) =>
            typeof value === 'string' ? storable(value) : value,
          ),
        })),
      )
      .execute();
  }

  /** @returns the run and its mismatches in the order they were found, or `null` */
  async findRun(
    tx: Tx,
    id: string,
  ): Promise<{ run: RunRecord; mismatches: Mismatch[] } | null> {
    const r = await db(tx)
      .selectFrom('reconciliation_runs')
      .select([
        'id',
        'settlement_date',
        'started_at',
        'finished_at',
        'settlement_rows',
        'matched',
        'mismatch_count',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) return null;
    const rows = await db(tx)
      .selectFrom('reconciliation_mismatches')
      .selectAll()
      .where('run_id', '=', id)
      .orderBy('id')
      .execute();
    return {
      run: {
        id: r.id,
        settlementDate: r.settlement_date,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        settlementRows: r.settlement_rows,
        matched: r.matched,
        mismatchCount: r.mismatch_count,
      },
      mismatches: rows.map((m) => ({
        type: m.type as MismatchType,
        reference: m.reference,
        depositId: m.deposit_id,
        ourAmountRial:
          m.our_amount_rial === null ? null : BigInt(m.our_amount_rial),
        theirAmountRial:
          m.their_amount_rial === null ? null : BigInt(m.their_amount_rial),
        details: m.details as Record<string, unknown>,
      })),
    };
  }

  /**
   * @function startOfTehranDay
   * @description The instant a Tehran calendar day begins, by the database's time zone data.
   * @param day - `YYYY-MM-DD`
   */
  async startOfTehranDay(tx: Tx, day: string): Promise<Date> {
    const { rows } = await sql<{ at: Date }>`
      SELECT (${day}::date)::timestamp AT TIME ZONE 'Asia/Tehran' AS at`.execute(
      db(tx),
    );
    return rows[0].at;
  }
}
