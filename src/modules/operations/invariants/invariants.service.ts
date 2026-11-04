import { Inject, Injectable } from '@nestjs/common';
import { Tx, TransactionRunner } from '../../../database/transaction-runner';
import {
  INVARIANT_VIOLATION_LIMIT,
  InvariantCheck,
  LedgerService,
  toInvariantCheck,
} from '../../ledger';
import { frozenMismatches } from './frozen-check';
import { OPEN_WITHDRAWAL_TOTALS } from './open-withdrawal-totals';
import type { OpenWithdrawalTotals } from './open-withdrawal-totals';

export interface InvariantsReport {
  /** True when every check passed. */
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly checks: readonly InvariantCheck[];
}

/**
 * @class InvariantsService
 * @description Proves the books are consistent: the ledger's own invariants plus FROZEN = open withdrawals. Lives in operations, not ledger, so the ledger never depends on withdrawal (modules.md).
 */
@Injectable()
export class InvariantsService {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly ledger: LedgerService,
    @Inject(OPEN_WITHDRAWAL_TOTALS)
    private readonly withdrawals: OpenWithdrawalTotals,
  ) {}

  /**
   * @function check
   * @description Runs every check in one read-only REPEATABLE READ transaction: all queries see the same snapshot, so a journal committing midway can't show up as a false violation, and the check can't write.
   * @returns the report
   */
  check(): Promise<InvariantsReport> {
    return this.runner.run((tx) => this.checkIn(tx), {
      isolation: 'REPEATABLE READ',
      readOnly: true,
    });
  }

  /**
   * @function checkIn
   * @description The checks themselves, on the caller's transaction. `check()` is the entry point; tests call this inside a rolled-back transaction to seed violations.
   * @param tx - the transaction to read in
   * @returns the report
   */
  async checkIn(tx: Tx): Promise<InvariantsReport> {
    const ledgerChecks = await this.ledger.checkLedger(tx);
    const frozen = await this.ledger.frozenBalances(tx);
    const open = await this.withdrawals.openTotals(tx);
    const frozenCheck = toInvariantCheck(
      'FROZEN_EQUALS_OPEN_WITHDRAWALS',
      frozenMismatches(frozen, open).slice(0, INVARIANT_VIOLATION_LIMIT + 1),
    );

    const checks = [...ledgerChecks, frozenCheck];
    return {
      ok: checks.every((c) => c.ok),
      checkedAt: new Date().toISOString(),
      checks,
    };
  }
}
