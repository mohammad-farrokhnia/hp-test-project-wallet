import { bigintTransformer } from './bigint.transformer';

describe('bigintTransformer', () => {
  it('writes a bigint as exact decimal text', () => {
    expect(bigintTransformer.to(9_007_199_254_740_993n)).toBe(
      '9007199254740993',
    );
    expect(bigintTransformer.to(-1n)).toBe('-1');
  });

  it('reads the pg string form back to a bigint without loss', () => {
    expect(bigintTransformer.from('9223372036854775807')).toBe(
      9_223_372_036_854_775_807n,
    );
    expect(bigintTransformer.from('-9223372036854775808')).toBe(
      -9_223_372_036_854_775_808n,
    );
  });

  it('passes null and undefined through', () => {
    expect(bigintTransformer.to(null)).toBeNull();
    expect(bigintTransformer.to(undefined)).toBeUndefined();
    expect(bigintTransformer.from(null)).toBeNull();
  });

  it('refuses a JS number, which may already have lost precision', () => {
    expect(() => {
      bigintTransformer.from(9_007_199_254_740_992);
    }).toThrow(/precision/);
  });
});
