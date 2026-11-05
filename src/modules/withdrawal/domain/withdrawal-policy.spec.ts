import { INT64_MAX, Money } from '../../../common/money';
import { buildPolicies, quoteWithdrawal } from './withdrawal-policy';

// The defaults from .env.example: 100,000 toman, 10 USDT, a 1 USDT fee, 1 USDT = 100,000 toman = 1,000,000 rial.
const limits = {
  withdrawMinRial: 1_000_000n,
  usdtWithdrawMinMicro: 10_000_000n,
  usdtWithdrawFeeMicro: 1_000_000n,
  usdtReferenceRateRial: 1_000_000n,
};
const policies = buildPolicies(limits);

describe('withdrawal policies', () => {
  describe('IRR', () => {
    const irr = policies.IRR;

    it('pays to an IBAN with no fee', () => {
      expect(irr.destinationType).toBe('IBAN');
      expect(irr.fee.equals(Money.zero('IRR'))).toBe(true);
    });

    it('refuses 99,999 toman and accepts exactly 100,000 (A1)', () => {
      expect(quoteWithdrawal(irr, Money.toman(99_999n))).toEqual({
        ok: false,
        reason: 'BELOW_MINIMUM',
      });
      expect(quoteWithdrawal(irr, Money.toman(100_000n)).ok).toBe(true);
    });

    it('freezes just the amount and counts all of it, in rial, toward the daily limit', () => {
      const r = quoteWithdrawal(irr, Money.toman(150_000n));
      expect(r.ok && r.quote.total.minor).toBe(1_500_000n);
      expect(r.ok && r.quote.limitAmountRial).toBe(1_500_000n);
    });

    it('has no reference rate: it is counted at face value', () => {
      const r = quoteWithdrawal(irr, Money.toman(150_000n));
      expect(irr.limitRateRialPerUsdt).toBeNull();
      expect(r.ok && r.quote.limitRateRialPerUsdt).toBeNull();
    });
  });

  describe('USDT', () => {
    const usdt = policies.USDT;
    const usd = (n: bigint) => Money.microUsdt(n * 1_000_000n);

    it('pays to a TRC20 address with a 1 USDT fee', () => {
      expect(usdt.destinationType).toBe('TRC20');
      expect(usdt.fee.equals(usd(1n))).toBe(true);
    });

    it('refuses 9.999999 USDT and accepts exactly 10', () => {
      expect(quoteWithdrawal(usdt, Money.microUsdt(9_999_999n)).ok).toBe(false);
      expect(quoteWithdrawal(usdt, usd(10n)).ok).toBe(true);
    });

    it('freezes amount + fee: withdrawing 10 needs 11 available (B1)', () => {
      const r = quoteWithdrawal(usdt, usd(10n));
      expect(r.ok && r.quote.total.equals(usd(11n))).toBe(true);
      expect(r.ok && r.quote.fee.equals(usd(1n))).toBe(true);
    });

    it('refuses an amount whose total with the fee cannot be held as TOO_LARGE, not an error', () => {
      expect(quoteWithdrawal(usdt, Money.microUsdt(INT64_MAX))).toEqual({
        ok: false,
        reason: 'TOO_LARGE',
      });
      expect(
        quoteWithdrawal(usdt, Money.microUsdt(INT64_MAX - 1_000_000n)).ok,
      ).toBe(true);
    });

    describe('daily limit at the reference rate (B2)', () => {
      const at = (rateRial: bigint) =>
        buildPolicies({ ...limits, usdtReferenceRateRial: rateRial }).USDT;
      const limitOf = (p: typeof policies.USDT, micro: bigint) => {
        const r = quoteWithdrawal(p, Money.microUsdt(micro));
        if (!r.ok) throw new Error('below the minimum');
        return r.quote;
      };

      it('counts the amount at the rate: 1,000 USDT at 100,000 toman is 100,000,000 toman', () => {
        const q = limitOf(usdt, 1_000_000_000n);
        expect(q.limitAmountRial).toBe(1_000_000_000n);
        expect(q.limitRateRialPerUsdt).toBe(1_000_000n);
      });

      it('does not count the fee', () => {
        const q = limitOf(usdt, 10_000_000n);
        expect(q.total.minor).toBe(11_000_000n);
        expect(q.limitAmountRial).toBe(10_000_000n);
      });

      it.each([
        [1_234_567n, 10_000_001n, 12_345_672n],
        [1_234_567n, 10_000_000n, 12_345_670n],
        [999_999n, 10_000_001n, 9_999_991n],
        [3n, 10_000_000n, 30n],
        [1n, 10_000_000n, 10n],
        [1n, 10_000_001n, 11n],
      ])(
        'rounds up, never down: rate %s rial per USDT, %s micro-USDT counts %s rial',
        (rate, micro, expected) => {
          expect(limitOf(at(rate), micro).limitAmountRial).toBe(expected);
        },
      );

      it('never counts a withdrawal as less than the exact value', () => {
        for (const rate of [1n, 7n, 999_999n, 1_000_000n, 1_234_567n]) {
          for (const micro of [10_000_000n, 10_000_001n, 10_999_999n]) {
            const counted = limitOf(at(rate), micro).limitAmountRial;
            expect(counted * 1_000_000n).toBeGreaterThanOrEqual(micro * rate);
            expect((counted - 1n) * 1_000_000n).toBeLessThan(micro * rate);
          }
        }
      });

      it('takes the rate from config, so a new rate prices new quotes only', () => {
        expect(limitOf(at(2_000_000n), 10_000_000n).limitAmountRial).toBe(
          20_000_000n,
        );
        expect(limitOf(usdt, 10_000_000n).limitAmountRial).toBe(10_000_000n);
      });
    });
  });

  it('follows the configured numbers', () => {
    const custom = buildPolicies({
      withdrawMinRial: 50n,
      usdtWithdrawMinMicro: 5n,
      usdtWithdrawFeeMicro: 2n,
      usdtReferenceRateRial: 5n,
    });
    expect(custom.IRR.minimum.minor).toBe(50n);
    expect(custom.USDT.fee.minor).toBe(2n);
  });

  it('refuses an amount in the wrong currency: a programming error', () => {
    expect(() => quoteWithdrawal(policies.IRR, Money.microUsdt(1n))).toThrow(
      /IRR policy got a USDT amount/,
    );
  });
});
