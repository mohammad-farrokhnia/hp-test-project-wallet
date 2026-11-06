import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { uuidv7 } from '../../../common/ids';
import { storable } from '../../../common/strings';
import { isCalendarDay, jalaliDate, tehranDay } from '../../../common/time';
import { TransactionRunner } from '../../../database/transaction-runner';
import { DepositService } from '../../deposit';
import type { BankReferenced } from '../../deposit/repositories/deposits.repository';
import { PSP_CLIENT } from '../../integrations/psp';
import type { PspClient } from '../../integrations/psp';
import {
  parseSettlement,
  ParsedSettlement,
  SettlementFormatError,
} from '../../integrations/psp/settlement-csv';
import { Mismatch, reconcile } from './reconcile';
import { ReconciliationRepository } from './reconciliation.repository';

/** A credit this soon after a day began may belong to the previous day's file. */
const NEAR_DAY_START_MS = 5 * 60_000;

/** A finished run: what was compared and everything that differed. */
export interface ReconciliationRun {
  readonly id: string;
  readonly date: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly settlementRows: number;
  readonly matched: number;
  readonly mismatches: readonly Mismatch[];
}

/**
 * @class ReconciliationService
 * @description `POST /reconciliation/run`: compares the PSP's settlement file for a Tehran day with the deposits we credited, by bank reference, and records the differences.
 * It only reads our side and writes only its own report: no deposit, journal or balance is touched, whatever it finds.
 * 1. fetch the file (`PspClient.getSettlement`) and parse it; no file, or not the file we know, is 503 `PROVIDER_UNAVAILABLE` and nothing is stored;
 * 2. in one read-only REPEATABLE READ transaction read our side (credited that day, and every deposit holding a reference in the file), so both lookups see one snapshot;
 * 3. `reconcile` (pure), then store the run with the exact file and every mismatch.
 * Running it again for the same day makes another report: each run is a record of what the PSP and we said at that time.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly runner: TransactionRunner,
    @Inject(PSP_CLIENT) private readonly psp: PspClient,
    private readonly deposits: DepositService,
    private readonly runs: ReconciliationRepository,
  ) {}

  /**
   * @function run
   * @param requested - the Tehran day, `YYYY-MM-DD`; today (by the database clock) when omitted
   * @returns the run
   * @throws {AppError} `VALIDATION_ERROR` (not a real day, or in the future), `PROVIDER_UNAVAILABLE`
   */
  async run(requested?: string): Promise<ReconciliationRun> {
    const startedAt = new Date();
    const today = await this.runner.run((tx) => tehranDay(tx), {
      readOnly: true,
    });
    const day = requested ?? today;
    if (!isCalendarDay(day)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'date must be a real day written YYYY-MM-DD',
      );
    }
    if (day > today) {
      throw new AppError(
        'VALIDATION_ERROR',
        'date is in the future: nothing is settled yet',
      );
    }

    const file = await this.psp.getSettlement(day);
    if (file.kind === 'UNAVAILABLE') {
      this.logger.warn(`settlement ${day}: no file (${file.reason})`);
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'The settlement file is not available',
      );
    }
    const parsed = this.parse(day, file.csv);

    const references = [...new Set(parsed.rows.map((r) => r.reference))];
    const result = await this.runner.run(
      async (tx) => {
        const creditedOnDay = await this.deposits.creditedOn(tx, day);
        const found = await this.deposits.byBankReferences(tx, references);
        const dayStart = await this.runs.startOfTehranDay(tx, day);
        return reconcile({
          settlement: parsed,
          jalaliDay: jalaliDate(day),
          creditedOnDay,
          byReference: byReference(found),
          nearStartBefore: new Date(dayStart.getTime() + NEAR_DAY_START_MS),
        });
      },
      { readOnly: true, isolation: 'REPEATABLE READ' },
    );

    const run: ReconciliationRun = {
      id: uuidv7(),
      date: day,
      startedAt,
      finishedAt: new Date(),
      settlementRows: parsed.rows.length + parsed.unreadable.length,
      matched: result.matched,
      mismatches: result.mismatches,
    };
    await this.runner.run((tx) =>
      this.runs.insertRun(tx, {
        id: run.id,
        settlementDate: day,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        settlementRows: run.settlementRows,
        matched: run.matched,
        mismatches: run.mismatches,
        rawCsv: storable(file.csv),
      }),
    );
    if (run.mismatches.length > 0) {
      this.logger.warn(
        `settlement ${day}: ${run.mismatches.length} mismatches in ${run.settlementRows} rows (run ${run.id})`,
      );
    }
    return run;
  }

  /**
   * @function get
   * @returns a stored run, or `null` when unknown
   */
  async get(id: string): Promise<ReconciliationRun | null> {
    const found = await this.runner.run((tx) => this.runs.findRun(tx, id), {
      readOnly: true,
    });
    if (!found) return null;
    const { run, mismatches } = found;
    return {
      id: run.id,
      date: run.settlementDate,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      settlementRows: run.settlementRows,
      matched: run.matched,
      mismatches,
    };
  }

  private parse(day: string, csv: string): ParsedSettlement {
    try {
      return parseSettlement(csv);
    } catch (err) {
      if (!(err instanceof SettlementFormatError)) throw err;
      this.logger.error(`settlement ${day}: ${err.message}`);
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'The settlement file is not in the expected format',
      );
    }
  }
}

/** Deposits by reference; if two share one without their zero padding, the credited one is the one that counts. */
function byReference(
  deposits: readonly BankReferenced[],
): Map<string, BankReferenced> {
  const map = new Map<string, BankReferenced>();
  for (const d of deposits) {
    const have = map.get(d.reference);
    if (!have || (have.status !== 'SUCCEEDED' && d.status === 'SUCCEEDED')) {
      map.set(d.reference, d);
    }
  }
  return map;
}
