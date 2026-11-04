export type LedgerErrorCode =
  'INVALID_JOURNAL' | 'ACCOUNT_NOT_FOUND' | 'INSUFFICIENT_BALANCE';

/** Thrown by the ledger; maps to 500 `INTERNAL_ERROR` at the edge, because every case is a caller bug. */
export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}
