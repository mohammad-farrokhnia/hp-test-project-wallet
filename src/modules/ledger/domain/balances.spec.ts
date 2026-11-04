import { Money } from '../../../common/money';
import { foldBalances } from './balances';

describe('foldBalances', () => {
  it('gives an unknown user zeros in every currency', () => {
    const b = foldBalances([]);
    expect([...b.keys()]).toEqual(['IRR', 'USDT']);
    for (const [code, v] of b) {
      expect(v.available.equals(Money.zero(code))).toBe(true);
      expect(v.frozen.equals(Money.zero(code))).toBe(true);
      expect(v.debt.equals(Money.zero(code))).toBe(true);
    }
  });

  it('places each account by kind and currency', () => {
    const b = foldBalances([
      { kind: 'AVAILABLE', balance: Money.rial(700n) },
      { kind: 'FROZEN', balance: Money.rial(300n) },
      { kind: 'DEBT', balance: Money.rial(0n) },
      { kind: 'AVAILABLE', balance: Money.microUsdt(5_000_000n) },
    ]);
    expect(b.get('IRR')!.available.minor).toBe(700n);
    expect(b.get('IRR')!.frozen.minor).toBe(300n);
    expect(b.get('USDT')!.available.minor).toBe(5_000_000n);
    expect(b.get('USDT')!.frozen.minor).toBe(0n);
  });
});
