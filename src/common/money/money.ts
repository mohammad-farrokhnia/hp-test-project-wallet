import { CurrencyCode, currencySpec } from './currency';
import { MoneyError } from './money.error';

export const INT64_MAX = 9_223_372_036_854_775_807n;
export const INT64_MIN = -9_223_372_036_854_775_808n;

/** Immutable amount of one currency in `bigint` minor units (rial, micro-USDT). */
export class Money {
  private constructor(
    readonly currency: CurrencyCode,
    readonly minor: bigint,
  ) {
    Object.freeze(this);
  }

  /**
   * @param currency - internal currency code
   * @param minor - amount in minor units
   * @throws {MoneyError} `UNKNOWN_CURRENCY`, `INVALID_AMOUNT`, `OUT_OF_RANGE`
   */
  static of(currency: CurrencyCode, minor: bigint): Money {
    currencySpec(currency);
    if (typeof minor !== 'bigint') {
      throw new MoneyError('INVALID_AMOUNT', 'minor units must be a bigint');
    }
    if (minor > INT64_MAX || minor < INT64_MIN) {
      throw new MoneyError(
        'OUT_OF_RANGE',
        `${minor.toString()} does not fit a BIGINT`,
      );
    }
    return new Money(currency, minor);
  }

  static zero(currency: CurrencyCode): Money {
    return Money.of(currency, 0n);
  }

  static rial(rial: bigint): Money {
    return Money.of('IRR', rial);
  }

  /** @param toman - whole toman */
  static toman(toman: bigint): Money {
    return Money.of('IRR', toman * 10n);
  }

  /** @param micro - amount in 10⁻⁶ USDT */
  static microUsdt(micro: bigint): Money {
    return Money.of('USDT', micro);
  }

  /** @throws {MoneyError} `CURRENCY_MISMATCH`, `OUT_OF_RANGE` */
  add(other: Money): Money {
    return Money.of(this.currency, this.minor + this.same(other).minor);
  }

  /** @throws {MoneyError} `CURRENCY_MISMATCH`, `OUT_OF_RANGE` */
  sub(other: Money): Money {
    return Money.of(this.currency, this.minor - this.same(other).minor);
  }

  /** @throws {MoneyError} `OUT_OF_RANGE` for the minimum BIGINT value. */
  negate(): Money {
    return Money.of(this.currency, -this.minor);
  }

  /** @throws {MoneyError} `OUT_OF_RANGE` for the minimum BIGINT value. */
  abs(): Money {
    return this.minor < 0n ? this.negate() : this;
  }

  /** @throws {MoneyError} `CURRENCY_MISMATCH` */
  compare(other: Money): -1 | 0 | 1 {
    const o = this.same(other).minor;
    return this.minor < o ? -1 : this.minor > o ? 1 : 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  /** @throws {MoneyError} `CURRENCY_MISMATCH` */
  lt(other: Money): boolean {
    return this.compare(other) < 0;
  }

  /** @throws {MoneyError} `CURRENCY_MISMATCH` */
  lte(other: Money): boolean {
    return this.compare(other) <= 0;
  }

  /** @throws {MoneyError} `CURRENCY_MISMATCH` */
  gt(other: Money): boolean {
    return this.compare(other) > 0;
  }

  /** @throws {MoneyError} `CURRENCY_MISMATCH` */
  gte(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  toString(): string {
    return `${this.minor.toString()} ${this.currency}`;
  }

  toJSON(): { currency: CurrencyCode; minor: string } {
    return { currency: this.currency, minor: this.minor.toString() };
  }

  private same(other: Money): Money {
    if (other.currency !== this.currency) {
      throw new MoneyError(
        'CURRENCY_MISMATCH',
        `cannot combine ${this.currency} with ${other.currency}`,
      );
    }
    return other;
  }
}
