import { Money } from '../../common/money';

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

export interface PostResult {
  readonly journalId: bigint;
  readonly alreadyBooked: boolean;
}

/** A user's FROZEN balance in one currency. */
export interface FrozenBalance {
  readonly userId: string;
  readonly balance: Money;
}
