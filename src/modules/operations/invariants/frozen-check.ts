import { Money } from '../../../common/money';
import { FrozenBalance, ViolationRow } from '../../ledger';
import { OpenWithdrawalTotal } from './open-withdrawal-totals';

/**
 * @function frozenMismatches
 * @description FROZEN must hold exactly the amount + fee of the user's open withdrawals, per currency. Compares both sides over every user and currency either side mentions; a missing side counts as zero.
 * @param frozen - non-zero FROZEN balances from the ledger
 * @param open - open withdrawal totals from the withdrawal module
 * @returns one row per user and currency where they differ, sorted
 */
export function frozenMismatches(
  frozen: readonly FrozenBalance[],
  open: readonly OpenWithdrawalTotal[],
): ViolationRow[] {
  const sides = new Map<string, { frozen?: Money; open?: Money }>();
  const key = (userId: string, m: Money) => `${userId}\u0000${m.currency}`;
  for (const f of frozen) {
    const k = key(f.userId, f.balance);
    sides.set(k, { ...sides.get(k), frozen: f.balance });
  }
  for (const o of open) {
    const k = key(o.userId, o.amount);
    const prev = sides.get(k)?.open;
    sides.set(k, {
      ...sides.get(k),
      open: prev ? prev.add(o.amount) : o.amount,
    });
  }

  const rows: ViolationRow[] = [];
  for (const [k, side] of [...sides].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [userId] = k.split('\u0000');
    const currency = (side.frozen ?? side.open)!.currency;
    const frozenMinor = side.frozen?.minor ?? 0n;
    const openMinor = side.open?.minor ?? 0n;
    if (frozenMinor === openMinor) continue;
    rows.push({
      user_id: userId,
      currency,
      frozen_minor: frozenMinor.toString(),
      open_withdrawals_minor: openMinor.toString(),
    });
  }
  return rows;
}
