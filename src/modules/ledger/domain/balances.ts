import { CURRENCIES, CurrencyCode, Money } from '../../../common/money';
import type { WalletBalances } from '../ledger.types';

/**
 * @function foldBalances
 * @description Groups a user's account rows into balances per currency. Every registered currency is present, zero where the user has no accounts yet.
 * @param rows - the user's accounts: kind and balance
 * @returns balances per currency, in registry order
 */
export function foldBalances(
  rows: readonly { kind: string; balance: Money }[],
): Map<CurrencyCode, WalletBalances> {
  const out = new Map<CurrencyCode, WalletBalances>();
  for (const code of Object.keys(CURRENCIES) as CurrencyCode[]) {
    const of = (kind: string) =>
      rows.find((r) => r.kind === kind && r.balance.currency === code)
        ?.balance ?? Money.zero(code);
    out.set(code, {
      available: of('AVAILABLE'),
      frozen: of('FROZEN'),
      debt: of('DEBT'),
    });
  }
  return out;
}
