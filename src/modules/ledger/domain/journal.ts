import { CurrencyCode, Money } from '../../../common/money';
import { LedgerError } from './ledger.error';

export type JournalKind =
  | 'DEPOSIT_CREDIT'
  | 'ADJUSTMENT_CREDIT'
  | 'WITHDRAWAL_FREEZE'
  | 'WITHDRAWAL_SETTLE'
  | 'WITHDRAWAL_RELEASE'
  | 'WITHDRAWAL_RETURN'
  | 'WITHDRAWAL_LATE_SUCCESS'
  | 'TRANSFER';

export type RefType = 'DEPOSIT' | 'WITHDRAWAL' | 'ADJUSTMENT' | 'TRANSFER';

/** The business record each journal kind books against; */
export const REF_TYPE_OF: Readonly<Record<JournalKind, RefType>> = {
  DEPOSIT_CREDIT: 'DEPOSIT',
  ADJUSTMENT_CREDIT: 'ADJUSTMENT',
  WITHDRAWAL_FREEZE: 'WITHDRAWAL',
  WITHDRAWAL_SETTLE: 'WITHDRAWAL',
  WITHDRAWAL_RELEASE: 'WITHDRAWAL',
  WITHDRAWAL_RETURN: 'WITHDRAWAL',
  WITHDRAWAL_LATE_SUCCESS: 'WITHDRAWAL',
  TRANSFER: 'TRANSFER',
};

export type UserAccountKind = 'AVAILABLE' | 'FROZEN' | 'DEBT';
export type SystemAccountKind =
  'PSP_CLEARING' | 'PAYOUT_CLEARING' | 'FEE_REVENUE' | 'OPS_ADJUSTMENTS';
export type AccountKind = UserAccountKind | SystemAccountKind;

/** One leg of a journal: a signed amount on one account. */
export interface JournalLine {
  readonly accountId: bigint;
  readonly amount: Money;
}

/** One business event that moves money. The ref type follows from the kind. */
export interface JournalInput {
  readonly kind: JournalKind;
  /** The deposit, withdrawal, adjustment or transfer id (uuid). */
  readonly refId: string;
  readonly currency: CurrencyCode;
  readonly description?: string;
  readonly reversesJournalId?: bigint;
  readonly lines: readonly JournalLine[];
}

/** An account row as read under its row lock. */
export interface LockedAccount {
  readonly id: bigint;
  readonly userId: string | null;
  readonly kind: AccountKind;
  readonly currency: CurrencyCode;
  readonly balance: Money;
  readonly allowNegative: boolean;
}

/** A posting ready to insert: the line plus what it copies from its account. */
export interface PlannedPosting {
  readonly account: LockedAccount;
  readonly amount: Money;
  readonly balanceAfter: Money;
}

/**
 * @function validateJournal
 * @description Checks a journal before any lock is taken: at least two lines, each non-zero and in the journal's currency, no account twice, and the lines sum to zero.
 * @param journal - the journal to book
 * @throws {LedgerError} `INVALID_JOURNAL`
 */
export function validateJournal(journal: JournalInput): void {
  const { lines, currency } = journal;
  if (lines.length < 2) {
    throw new LedgerError(
      'INVALID_JOURNAL',
      'a journal needs at least two lines',
    );
  }
  const seen = new Set<bigint>();
  let sum = Money.zero(currency);
  for (const line of lines) {
    if (line.amount.currency !== currency) {
      throw new LedgerError(
        'INVALID_JOURNAL',
        `line on account ${line.accountId} is ${line.amount.currency}, journal is ${currency}`,
      );
    }
    if (line.amount.isZero()) {
      throw new LedgerError(
        'INVALID_JOURNAL',
        `line on account ${line.accountId} is zero`,
      );
    }
    if (seen.has(line.accountId)) {
      throw new LedgerError(
        'INVALID_JOURNAL',
        `account ${line.accountId} appears twice`,
      );
    }
    seen.add(line.accountId);
    sum = sum.add(line.amount);
  }
  if (!sum.isZero()) {
    throw new LedgerError(
      'INVALID_JOURNAL',
      `lines sum to ${sum.toString()}, not zero`,
    );
  }
}

/**
 * @function planPostings
 * @description Computes each posting's balance after, in line order, against the locked balances. Refuses a protected balance going below zero and a DEBT balance going above zero, so the database CHECKs are never the first line of defence.
 * @param journal - a journal that passed `validateJournal`
 * @param accounts - the locked accounts, by id
 * @returns one planned posting per line
 * @throws {LedgerError} `ACCOUNT_NOT_FOUND`, `INVALID_JOURNAL`, `INSUFFICIENT_BALANCE`
 */
export function planPostings(
  journal: JournalInput,
  accounts: ReadonlyMap<bigint, LockedAccount>,
): PlannedPosting[] {
  return journal.lines.map((line) => {
    const account = accounts.get(line.accountId);
    if (!account) {
      throw new LedgerError(
        'ACCOUNT_NOT_FOUND',
        `account ${line.accountId} does not exist`,
      );
    }
    if (account.currency !== journal.currency) {
      throw new LedgerError(
        'INVALID_JOURNAL',
        `account ${account.id} is ${account.currency}, journal is ${journal.currency}`,
      );
    }
    const balanceAfter = account.balance.add(line.amount);
    if (!account.allowNegative && balanceAfter.isNegative()) {
      throw new LedgerError(
        'INSUFFICIENT_BALANCE',
        `account ${account.id} (${account.kind}) would go to ${balanceAfter.toString()}`,
      );
    }
    if (account.kind === 'DEBT' && balanceAfter.isPositive()) {
      throw new LedgerError(
        'INVALID_JOURNAL',
        `DEBT account ${account.id} would go above zero`,
      );
    }
    return { account, amount: line.amount, balanceAfter };
  });
}
