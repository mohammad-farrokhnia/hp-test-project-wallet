import {
  apiCurrencyCode,
  formatApiAmount,
  parseApiAmount,
  parseProviderAmount,
  toProviderAmount,
} from './amount';
import { Money } from './money';
import { MoneyError, MoneyErrorCode } from './money.error';

function expectMoneyError(
  fn: () => unknown,
  code: MoneyErrorCode,
  why = '',
): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe(code);
    return;
  }
  throw new Error(`expected MoneyError ${code} (${why}), nothing was thrown`);
}

describe('parseApiAmount', () => {
  describe('IRT (whole toman in, rial out)', () => {
    it.each([
      ['0', 0n],
      ['1', 10n],
      ['1000', 10_000n],
      ['1.0', 10n],
      ['1000.00', 10_000n],
      ['0.0', 0n],
      ['100000', 1_000_000n],
      ['200000000', 2_000_000_000n],
      ['922337203685477580', 9_223_372_036_854_775_800n],
    ])('accepts "%s" as %s rial', (input, rial) => {
      const m = parseApiAmount('IRT', input);
      expect(m.currency).toBe('IRR');
      expect(m.minor).toBe(rial);
    });

    it.each([
      ['0.1', 'a decimal'],
      ['1.5', 'a non-zero decimal'],
      ['1.0000001', 'a non-zero digit after zeros'],
      ['1500.5', 'a decimal (PSP-02)'],
      ['1e5', 'exponent notation'],
      ['1E5', 'exponent notation'],
      ['1e-3', 'exponent notation'],
      ['', 'empty'],
      [' 1', 'leading space'],
      ['1 ', 'trailing space'],
      ['\n1', 'newline'],
      ['-1', 'negative'],
      ['+1', 'explicit plus'],
      ['-0', 'negative zero'],
      ['01', 'leading zero'],
      ['00', 'leading zeros'],
      ['1.', 'trailing dot'],
      ['.5', 'no whole part'],
      ['1,000', 'thousands separator'],
      ['1_000', 'underscore separator'],
      ['0x10', 'hex'],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['١٢٣', 'Arabic-Indic digits'],
      ['۱۲۳', 'Persian digits'],
      ['1'.repeat(41), 'longer than any BIGINT'],
    ])('rejects %j (%s)', (input) => {
      expectMoneyError(() => parseApiAmount('IRT', input), 'INVALID_AMOUNT');
    });

    it('rejects a toman amount whose rial value no longer fits a BIGINT', () => {
      expectMoneyError(
        () => parseApiAmount('IRT', '922337203685477581'),
        'INVALID_AMOUNT',
      );
    });
  });

  describe('USDT (up to 6 decimals, micro-USDT out)', () => {
    it.each([
      ['0', 0n],
      ['0.0', 0n],
      ['1', 1_000_000n],
      ['10', 10_000_000n],
      ['10.5', 10_500_000n],
      ['10.50', 10_500_000n],
      ['10.00000000', 10_000_000n],
      ['0.0000000', 0n],
      ['0.1', 100_000n],
      ['0.000001', 1n],
      ['0.999999', 999_999n],
      ['123456.123456', 123_456_123_456n],
      ['9223372036854.775807', 9_223_372_036_854_775_807n],
    ])('accepts "%s" as %s micro', (input, micro) => {
      const m = parseApiAmount('USDT', input);
      expect(m.currency).toBe('USDT');
      expect(m.minor).toBe(micro);
    });

    it.each([
      ['0.0000001', '7 decimals'],
      ['1.1234567', '7 decimals'],
      ['10.0000001', '7 decimals, last one non-zero'],
      ['1e5', 'exponent notation'],
      ['1e-6', 'exponent notation'],
      ['1.5e1', 'exponent notation'],
      ['.5', 'no whole part'],
      ['5.', 'trailing dot'],
      ['-0.1', 'negative'],
      ['1.5.2', 'two dots'],
      ['1,5', 'comma as decimal separator'],
      ['1 000', 'space inside'],
      ['', 'empty'],
      ['0.1\u0000', 'NUL byte'],
    ])('rejects %j (%s)', (input) => {
      expectMoneyError(() => parseApiAmount('USDT', input), 'INVALID_AMOUNT');
    });

    it('rejects one micro past the BIGINT range', () => {
      expectMoneyError(
        () => parseApiAmount('USDT', '9223372036854.775808'),
        'INVALID_AMOUNT',
      );
    });
  });

  it.each([
    [100000, 'a JS number (could be a float, or already rounded)'],
    [0.1, 'a float'],
    [10n, 'a bigint'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{}, 'an object'],
    [['1'], 'an array'],
    [true, 'a boolean'],
  ])('rejects %p: not a string (%s)', (input, why) => {
    expectMoneyError(() => parseApiAmount('IRT', input), 'INVALID_AMOUNT', why);
    expectMoneyError(
      () => parseApiAmount('USDT', input),
      'INVALID_AMOUNT',
      why,
    );
  });

  it.each([
    ['IRR', 'the internal code is not an API code'],
    ['irt', 'case matters'],
    ['Usdt', 'case matters'],
    ['BTC', 'unsupported'],
    ['', 'empty'],
    ['toString', 'prototype property names'],
    ['__proto__', 'prototype property names'],
    ['constructor', 'prototype property names'],
  ])('rejects currency %j (%s)', (code) => {
    expectMoneyError(() => parseApiAmount(code, '1'), 'UNKNOWN_CURRENCY');
  });
});

describe('formatApiAmount', () => {
  it.each([
    ['IRR', 0n, '0'],
    ['IRR', 10n, '1'],
    ['IRR', 10_000n, '1000'],
    ['IRR', 1_000_000n, '100000'],
    ['IRR', 2_000_000_000n, '200000000'],
    ['IRR', 5n, '0.5'],
    ['IRR', 15n, '1.5'],
    ['IRR', 1n, '0.1'],
    ['IRR', -15n, '-1.5'],
    ['IRR', -10_000n, '-1000'],
    ['IRR', 9_223_372_036_854_775_800n, '922337203685477580'],
    ['IRR', 9_223_372_036_854_775_807n, '922337203685477580.7'],
    ['USDT', 0n, '0'],
    ['USDT', 1n, '0.000001'],
    ['USDT', 10n, '0.00001'],
    ['USDT', 100_000n, '0.1'],
    ['USDT', 1_000_000n, '1'],
    ['USDT', 10_000_000n, '10'],
    ['USDT', 10_500_000n, '10.5'],
    ['USDT', 10_500_001n, '10.500001'],
    ['USDT', -1n, '-0.000001'],
    ['USDT', -10_500_000n, '-10.5'],
    ['USDT', 9_223_372_036_854_775_807n, '9223372036854.775807'],
    ['USDT', -9_223_372_036_854_775_808n, '-9223372036854.775808'],
  ] as const)('%s %s minor → "%s"', (currency, minor, expected) => {
    expect(formatApiAmount(Money.of(currency, minor))).toBe(expected);
  });

  it('names the client-facing currency (IRR is shown as IRT)', () => {
    expect(apiCurrencyCode(Money.rial(1n))).toBe('IRT');
    expect(apiCurrencyCode(Money.microUsdt(1n))).toBe('USDT');
  });
});

describe('API round trip', () => {
  it.each([
    ['IRT', '0'],
    ['IRT', '1'],
    ['IRT', '100000'],
    ['IRT', '922337203685477580'],
    ['USDT', '0'],
    ['USDT', '0.000001'],
    ['USDT', '10'],
    ['USDT', '10.5'],
    ['USDT', '9223372036854.775807'],
  ])('%s "%s" parses and formats back unchanged', (currency, text) => {
    expect(formatApiAmount(parseApiAmount(currency, text))).toBe(text);
  });

  it('is exact for every micro-USDT in a boundary sweep', () => {
    for (const micro of [
      1n,
      9n,
      10n,
      99n,
      100n,
      999_999n,
      1_000_000n,
      1_000_001n,
    ]) {
      const m = Money.microUsdt(micro);
      expect(parseApiAmount('USDT', formatApiAmount(m)).equals(m)).toBe(true);
    }
  });

  it('keeps the toman ↔ rial conversion exact at 10× for every whole toman tried', () => {
    for (const toman of [0n, 1n, 9n, 10n, 999n, 1_000n, 123_456_789n]) {
      expect(parseApiAmount('IRT', toman.toString()).minor).toBe(toman * 10n);
      expect(
        Money.toman(toman).equals(parseApiAmount('IRT', toman.toString())),
      ).toBe(true);
    }
  });
});

describe('toProviderAmount', () => {
  it.each([
    ['IRR', 0n, '0'],
    ['IRR', 1_000_000n, '1000000'],
    ['IRR', 15n, '15'],
    ['USDT', 10_000_000n, '10'],
    ['USDT', 10_500_000n, '10.5'],
    ['USDT', 1n, '0.000001'],
  ] as const)('%s %s minor → "%s"', (currency, minor, expected) => {
    expect(toProviderAmount(Money.of(currency, minor))).toBe(expected);
  });

  it('refuses to send a negative amount', () => {
    expectMoneyError(() => toProviderAmount(Money.rial(-1n)), 'INVALID_AMOUNT');
  });
});

describe('parseProviderAmount', () => {
  it.each([
    ['IRR', '1000000', 1_000_000n],
    ['IRR', '1000000.0', 1_000_000n],
    ['IRR', 1_000_000, 1_000_000n],
    ['IRR', '0', 0n],
    ['IRR', 9_007_199_254_740_991, 9_007_199_254_740_991n],
    ['USDT', '10', 10_000_000n],
    ['USDT', '10.5', 10_500_000n],
    ['USDT', '0.000001', 1n],
  ] as const)('%s %p → %s minor', (currency, raw, minor) => {
    const m = parseProviderAmount(currency, raw);
    expect(m.currency).toBe(currency);
    expect(m.minor).toBe(minor);
  });

  it.each([
    ['IRR', 1500.5, 'a fractional number'],
    [
      'IRR',
      9_007_199_254_740_992,
      'a number past 2^53 - 1, may already be rounded',
    ],
    ['IRR', -1, 'a negative number'],
    ['IRR', Number.NaN, 'NaN'],
    ['IRR', '1000000.5', 'a fractional rial'],
    ['IRR', '1e6', 'exponent notation (PSP-02)'],
    ['IRR', '-5', 'a negative string'],
    ['IRR', null, 'null'],
    ['USDT', 10.5, 'a USDT number: must be a string (PAY-01)'],
    ['USDT', 10, 'a USDT number even when whole'],
    ['USDT', '10.1234567', '7 decimals'],
    ['USDT', '1e1', 'exponent notation'],
  ] as const)('rejects %s %p (%s)', (currency, raw, why) => {
    expectMoneyError(
      () => parseProviderAmount(currency, raw),
      'INVALID_AMOUNT',
      why,
    );
  });

  it('rejects a provider amount beyond the BIGINT range', () => {
    expectMoneyError(
      () => parseProviderAmount('IRR', '9223372036854775808'),
      'INVALID_AMOUNT',
    );
  });
});
