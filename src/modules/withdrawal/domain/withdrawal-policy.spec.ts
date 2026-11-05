import { Money } from '../../../common/money';
import { buildPolicies, quoteWithdrawal } from './withdrawal-policy';

// The defaults from .env.example: 100,000 toman, 10 USDT, a 1 USDT fee.
const policies = buildPolicies({
  withdrawMinRial: 1_000_000n,
  usdtWithdrawMinMicro: 10_000_000n,
  usdtWithdrawFeeMicro: 1_000_000n,
});

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

    it('does not count toward the toman limit until B2 prices it', () => {
      const r = quoteWithdrawal(usdt, usd(1000n));
      expect(r.ok && r.quote.limitAmountRial).toBe(0n);
    });
  });

  it('follows the configured numbers', () => {
    const custom = buildPolicies({
      withdrawMinRial: 50n,
      usdtWithdrawMinMicro: 5n,
      usdtWithdrawFeeMicro: 2n,
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
