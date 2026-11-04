import { Money } from '../../../common/money';
import { creditLines } from './credit';

const irr = (n: bigint) => Money.rial(n);
const target = (debt: bigint) => ({
  availableId: 1n,
  debtId: 2n,
  debt: irr(debt),
});
const amounts = (lines: ReturnType<typeof creditLines>) =>
  lines.map((l) => [l.accountId, l.amount.minor]);

describe('creditLines: incoming money pays DEBT first', () => {
  it('without debt, everything goes to AVAILABLE', () => {
    expect(amounts(creditLines(target(0n), irr(500n)))).toEqual([[1n, 500n]]);
  });

  it('with less debt than the credit, clears the debt and keeps the rest', () => {
    expect(amounts(creditLines(target(-200n), irr(500n)))).toEqual([
      [2n, 200n],
      [1n, 300n],
    ]);
  });

  it('with exactly the debt, clears it and leaves AVAILABLE untouched', () => {
    expect(amounts(creditLines(target(-500n), irr(500n)))).toEqual([
      [2n, 500n],
    ]);
  });

  it('with more debt than the credit, everything pays debt', () => {
    expect(amounts(creditLines(target(-900n), irr(500n)))).toEqual([
      [2n, 500n],
    ]);
  });

  it.each([0n, -1n])('refuses a credit of %s', (n) => {
    expect(() => creditLines(target(0n), irr(n))).toThrow(/must be positive/);
  });
});
