export type MoneyErrorCode =
  'INVALID_AMOUNT' | 'UNKNOWN_CURRENCY' | 'CURRENCY_MISMATCH' | 'OUT_OF_RANGE';

export class MoneyError extends Error {
  constructor(
    readonly code: MoneyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}
