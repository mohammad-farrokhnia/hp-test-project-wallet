import {
  apiCurrencyCode,
  CurrencyCode,
  formatApiAmount,
} from '../../common/money';
import { HistoryEntry, HistoryPage, WalletBalances } from '../ledger';
import { encodeCursor } from './domain/history-query';

export interface WalletResponse {
  readonly userId: string;
  readonly balances: readonly {
    readonly currency: string;
    readonly available: string;
    readonly frozen: string;
    readonly total: string;
    readonly debt: string;
  }[];
}

export interface HistoryItem {
  readonly id: string;
  readonly journalId: string;
  readonly type: string;
  readonly bucket: string;
  readonly currency: string;
  readonly amount: string;
  readonly balanceAfter: string;
  readonly reference: { readonly type: string; readonly id: string };
  readonly description: string | null;
  readonly createdAt: string;
}

export interface HistoryResponse {
  readonly items: readonly HistoryItem[];
  readonly nextCursor: string | null;
}

/**
 * @function toWalletResponse
 * @description API shape of `GET /wallets/:userId`: amounts in API units (IRT toman, USDT), total = available + frozen, debt as the positive amount owed.
 */
export function toWalletResponse(
  userId: string,
  balances: ReadonlyMap<CurrencyCode, WalletBalances>,
): WalletResponse {
  return {
    userId,
    balances: [...balances.values()].map((b) => ({
      currency: apiCurrencyCode(b.available),
      available: formatApiAmount(b.available),
      frozen: formatApiAmount(b.frozen),
      total: formatApiAmount(b.available.add(b.frozen)),
      debt: formatApiAmount(b.debt.negate()),
    })),
  };
}

/** API shape of one history line: signed amount and balance after, in API units. */
export function toHistoryItem(e: HistoryEntry): HistoryItem {
  return {
    id: e.postingId.toString(),
    journalId: e.journalId.toString(),
    type: e.journalKind,
    bucket: e.bucket,
    currency: apiCurrencyCode(e.amount),
    amount: formatApiAmount(e.amount),
    balanceAfter: formatApiAmount(e.balanceAfter),
    reference: { type: e.refType, id: e.refId },
    description: e.description,
    createdAt: e.createdAt.toISOString(),
  };
}

/** API shape of `GET /wallets/:userId/ledger`. */
export function toHistoryResponse(page: HistoryPage): HistoryResponse {
  return {
    items: page.entries.map(toHistoryItem),
    nextCursor:
      page.nextBeforeId === null ? null : encodeCursor(page.nextBeforeId),
  };
}
