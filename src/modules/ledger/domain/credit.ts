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
 * @description The only way money reaches a user: it pays off DEBT first, and only the rest lands in AVAILABLE. So AVAILABLE > 0 always means DEBT = 0, and a user in debt can never withdraw.
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
