import { Money } from '../../common/money';
import type { JournalKind, SystemAccountKind } from './domain/journal';

export type {
  JournalInput,
  JournalKind,
  JournalLine,
  SystemAccountKind,
} from './domain/journal';
export {
  INVARIANT_VIOLATION_LIMIT,
  toInvariantCheck,
} from './domain/invariants';
export type {
  InvariantCheck,
  InvariantName,
  ViolationRow,
} from './domain/invariants';
export { clawbackLines, creditLines } from './domain/credit';
export { LedgerError } from './domain/ledger.error';
export type { LedgerErrorCode } from './domain/ledger.error';

/**
 * @description The three accounts a user holds in one currency. Ids are `bigint` so lock ordering compares numerically.
 */
export interface UserAccountIds {
  readonly available: bigint;
  readonly frozen: bigint;
  readonly debt: bigint;
}

/** A user's three accounts in one currency, read under their row locks. */
export interface LockedUserAccounts {
  readonly ids: UserAccountIds;
  readonly available: Money;
  readonly frozen: Money;
  /** Zero or negative. */
  readonly debt: Money;
}

/** One user's balances in one currency. `debt` is zero or negative, as stored. */
export interface WalletBalances {
  readonly available: Money;
  readonly frozen: Money;
  readonly debt: Money;
}

/** One posting on a user's account, with its journal: a line of wallet history. */
export interface HistoryEntry {
  readonly postingId: bigint;
  readonly journalId: bigint;
  readonly journalKind: JournalKind;
  readonly bucket: 'AVAILABLE' | 'FROZEN' | 'DEBT';
  /** Signed: negative when money left the bucket. */
  readonly amount: Money;
  readonly balanceAfter: Money;
  readonly refType: string;
  readonly refId: string;
  readonly description: string | null;
  readonly createdAt: Date;
}

/** A page of history, newest first. */
export interface HistoryPage {
  readonly entries: readonly HistoryEntry[];
  readonly nextBeforeId: bigint | null;
}

/** A credit to a user from a system account (deposit, adjustment). */
export interface CreditUserInput {
  readonly userId: string;
  /** Positive; its currency is the journal's. */
  readonly amount: Money;
  /** The system account the money comes from, e.g. `OPS_ADJUSTMENTS`. */
  readonly source: SystemAccountKind;
  readonly kind: JournalKind;
  /** The business record id (uuid). */
  readonly refId: string;
  readonly description?: string;
}

/** What `LedgerService.post` booked. */
export interface PostResult {
  readonly journalId: bigint;
  readonly alreadyBooked: boolean;
}

/** A user's FROZEN balance in one currency. */
export interface FrozenBalance {
  readonly userId: string;
  readonly balance: Money;
}
