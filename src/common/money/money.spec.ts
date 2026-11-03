import { currencyFromApiCode, currencySpec, CURRENCIES } from './currency';
import { INT64_MAX, INT64_MIN, Money } from './money';
import { MoneyError } from './money.error';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof MoneyError
      ? err.code
      : `not a MoneyError: ${String(err)}`;
  }
  return undefined;
};

describe('currency registry', () => {
  it('has IRR (API: IRT, toman = 10 rial) and USDT (6 decimals)', () => {
    expect(CURRENCIES.IRR).toMatchObject({
      apiCode: 'IRT',
      apiScale: 1,
      apiInputScale: 0,
      providerScale: 0,
    });
    expect(CURRENCIES.USDT).toMatchObject({
      apiCode: 'USDT',
      apiScale: 6,
      apiInputScale: 6,
      providerScale: 6,
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CURRENCIES)).toBe(true);
    expect(Object.isFrozen(CURRENCIES.IRR)).toBe(true);
  });

  it('resolves internal and API codes, and nothing else', () => {
    expect(currencySpec('IRR').code).toBe('IRR');
    expect(currencyFromApiCode('IRT').code).toBe('IRR');
    expect(code(() => currencySpec('IRT'))).toBe('UNKNOWN_CURRENCY');
    expect(code(() => currencySpec('toString'))).toBe('UNKNOWN_CURRENCY');
    expect(code(() => currencyFromApiCode('IRR'))).toBe('UNKNOWN_CURRENCY');
  });
});

describe('Money', () => {
  it('builds from rial, toman and micro-USDT', () => {
    expect(Money.rial(15n).minor).toBe(15n);
    expect(Money.toman(1_000n).minor).toBe(10_000n);
    expect(Money.microUsdt(10_000_000n)).toMatchObject({
      currency: 'USDT',
      minor: 10_000_000n,
    });
    expect(Money.zero('USDT').isZero()).toBe(true);
  });

  it('is immutable', () => {
    const m = Money.rial(1n);
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      (m as { minor: bigint }).minor = 2n;
    }).toThrow(TypeError);
  });

  it.each([
    ['INT64_MAX', INT64_MAX],
    ['INT64_MIN', INT64_MIN],
    ['zero', 0n],
  ])('accepts the BIGINT boundary %s', (_name, minor) => {
    expect(Money.rial(minor).minor).toBe(minor);
  });

  it.each([
    ['INT64_MAX + 1', INT64_MAX + 1n],
    ['INT64_MIN - 1', INT64_MIN - 1n],
    ['10^30', 10n ** 30n],
  ])('rejects %s as OUT_OF_RANGE', (_name, minor) => {
    expect(code(() => Money.rial(minor))).toBe('OUT_OF_RANGE');
  });

  it('rejects a non-bigint and an unknown currency', () => {
    expect(code(() => Money.of('IRR', 5 as unknown as bigint))).toBe(
      'INVALID_AMOUNT',
    );
    expect(code(() => Money.of('EUR' as 'IRR', 5n))).toBe('UNKNOWN_CURRENCY');
  });

  describe('arithmetic', () => {
    it('adds, subtracts and negates exactly', () => {
      const a = Money.rial(1_000_000n);
      const b = Money.rial(15n);
      expect(a.add(b).minor).toBe(1_000_015n);
      expect(a.sub(b).minor).toBe(999_985n);
      expect(b.sub(a).minor).toBe(-999_985n);
      expect(a.negate().minor).toBe(-1_000_000n);
      expect(a.negate().abs().equals(a)).toBe(true);
    });

    it('has no floating-point drift (0.1 + 0.2 = 0.3)', () => {
      const sum = Money.microUsdt(100_000n).add(Money.microUsdt(200_000n));
      expect(sum.equals(Money.microUsdt(300_000n))).toBe(true);
    });

    it('refuses to mix currencies', () => {
      expect(code(() => Money.rial(1n).add(Money.microUsdt(1n)))).toBe(
        'CURRENCY_MISMATCH',
      );
      expect(code(() => Money.rial(1n).sub(Money.microUsdt(1n)))).toBe(
        'CURRENCY_MISMATCH',
      );
      expect(code(() => Money.rial(1n).compare(Money.microUsdt(1n)))).toBe(
        'CURRENCY_MISMATCH',
      );
    });

    it('fails on overflow instead of wrapping', () => {
      expect(code(() => Money.rial(INT64_MAX).add(Money.rial(1n)))).toBe(
        'OUT_OF_RANGE',
      );
      expect(code(() => Money.rial(INT64_MIN).sub(Money.rial(1n)))).toBe(
        'OUT_OF_RANGE',
      );

      expect(code(() => Money.rial(INT64_MIN).negate())).toBe('OUT_OF_RANGE');
    });
  });

  describe('comparison', () => {
    const small = Money.rial(1n);
    const big = Money.rial(2n);
    it('orders values', () => {
      expect(small.compare(big)).toBe(-1);
      expect(big.compare(small)).toBe(1);
      expect(small.compare(Money.rial(1n))).toBe(0);
      expect([
        small.lt(big),
        small.lte(big),
        big.gt(small),
        big.gte(small),
      ]).toEqual([true, true, true, true]);
      expect([
        big.lt(small),
        big.lte(small),
        small.gt(big),
        small.gte(big),
      ]).toEqual([false, false, false, false]);
    });
    it('equals needs the same currency and amount', () => {
      expect(Money.rial(1n).equals(Money.rial(1n))).toBe(true);
      expect(Money.rial(1n).equals(Money.microUsdt(1n))).toBe(false);
    });
    it('reports sign', () => {
      expect([
        Money.rial(1n).isPositive(),
        Money.rial(0n).isPositive(),
        Money.rial(-1n).isNegative(),
      ]).toEqual([true, false, true]);
    });
  });

  it('stringifies exactly for logs and JSON', () => {
    const m = Money.of('USDT', INT64_MAX);
    expect(m.toString()).toBe('9223372036854775807 USDT');
    expect(JSON.stringify({ m })).toBe(
      '{"m":{"currency":"USDT","minor":"9223372036854775807"}}',
    );
  });
});
