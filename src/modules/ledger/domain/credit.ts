import { Money } from '../../../common/money';
import { JournalLine } from './journal';
import { LedgerError } from './ledger.error';

/** The user side of a credit: where the money may go, and how much is owed. */
export interface CreditTarget {
  readonly availableId: bigint;
  readonly debtId: bigint;
  readonly debt: Money;
}

/**
 * @function creditLines
 * @description The only way money reaches a user: it pays off DEBT first, and only the rest lands in AVAILABLE (ADR-10). So AVAILABLE > 0 always means DEBT = 0, and a user in debt can never withdraw.
 * @param target - the user's accounts and current debt
 * @param amount - the credit, greater than zero
 * @returns one or two positive lines: DEBT, AVAILABLE, or both
 * @throws {LedgerError} `INVALID_JOURNAL` when the amount is not positive
 */
export function creditLines(
  target: CreditTarget,
  amount: Money,
): JournalLine[] {
  if (!amount.isPositive()) {
    throw new LedgerError(
      'INVALID_JOURNAL',
      `a credit must be positive, got ${amount.toString()}`,
    );
  }
  const owed = target.debt.negate();
  const toDebt = owed.lt(amount) ? owed : amount;
  const toAvailable = amount.sub(toDebt);

  const lines: JournalLine[] = [];
  if (toDebt.isPositive()) {
    lines.push({ accountId: target.debtId, amount: toDebt });
  }
  if (toAvailable.isPositive()) {
    lines.push({ accountId: target.availableId, amount: toAvailable });
  }
  return lines;
}

/** The user side of a claw-back: where the money is taken from, and what is there. */
export interface ClawbackTarget {
  readonly availableId: bigint;
  readonly debtId: bigint;
  readonly available: Money;
}

/**
 * @function clawbackLines
 * @description The mirror of `creditLines`, for money that left after all:
 * take what AVAILABLE holds, and record the rest as DEBT. AVAILABLE never goes negative; DEBT may.
 * @param target - the user's accounts and current available balance
 * @param amount - what must be taken back, greater than zero
 * @returns one or two negative lines: AVAILABLE, DEBT, or both
 * @throws {LedgerError} `INVALID_JOURNAL` when the amount is not positive
 */
export function clawbackLines(
  target: ClawbackTarget,
  amount: Money,
): JournalLine[] {
  if (!amount.isPositive()) {
    throw new LedgerError(
      'INVALID_JOURNAL',
      `a claw-back must be positive, got ${amount.toString()}`,
    );
  }
  const fromAvailable = target.available.lt(amount) ? target.available : amount;
  const toDebt = amount.sub(fromAvailable);

  const lines: JournalLine[] = [];
  if (fromAvailable.isPositive()) {
    lines.push({
      accountId: target.availableId,
      amount: fromAvailable.negate(),
    });
  }
  if (toDebt.isPositive()) {
    lines.push({ accountId: target.debtId, amount: toDebt.negate() });
  }
  return lines;
}
