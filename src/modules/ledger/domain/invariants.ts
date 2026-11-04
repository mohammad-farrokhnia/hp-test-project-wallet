export type InvariantName =
  | 'ZERO_SUM'
  | 'BALANCE_EQUALS_POSTINGS'
  | 'NO_NEGATIVE_BALANCES'
  | 'AVAILABLE_ONLY_WITHOUT_DEBT'
  | 'FROZEN_EQUALS_OPEN_WITHDRAWALS';

/** One offending row, every value as text so the report serialises as-is. */
export type ViolationRow = Record<string, string | null>;

/** One invariant's result. */
export interface InvariantCheck {
  readonly name: InvariantName;
  readonly ok: boolean;
  readonly violations: readonly ViolationRow[];
  readonly truncated: boolean;
}

/** Violations listed per check; enough to act on, small enough to return over HTTP. */
export const INVARIANT_VIOLATION_LIMIT = 100;

/**
 * @function toInvariantCheck
 * @description Turns offending rows into one check result. Queries fetch `INVARIANT_VIOLATION_LIMIT + 1` rows so the extra one marks the list as truncated.
 * @param name - the invariant
 * @param rows - every offending row found, up to the limit plus one
 * @returns the check result
 */
export function toInvariantCheck(
  name: InvariantName,
  rows: readonly ViolationRow[],
): InvariantCheck {
  return {
    name,
    ok: rows.length === 0,
    violations: rows.slice(0, INVARIANT_VIOLATION_LIMIT),
    truncated: rows.length > INVARIANT_VIOLATION_LIMIT,
  };
}
