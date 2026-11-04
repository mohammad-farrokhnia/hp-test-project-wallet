import { Injectable } from '@nestjs/common';
import { CurrencyCode, Money } from '../../../common/money';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';
import { JournalKind } from '../domain/journal';
import { HistoryEntry } from '../ledger.types';

/**
 * @class HistoryRepository
 * @description Read-only queries for wallets: balances and history. No locks, no writes.
 */
@Injectable()
export class HistoryRepository {
  /**
   * @function userBalances
   * @description The user's account rows, via the unique `(user_id, kind, currency)` index.
   * @returns kind, currency and balance per existing account; empty for an unknown user
   */
  async userBalances(
    tx: Tx,
    userId: string,
  ): Promise<{ kind: string; balance: Money }[]> {
    const rows = await db(tx)
      .selectFrom('accounts')
      .select(['kind', 'currency', 'balance_minor'])
      .where('user_id', '=', userId)
      .execute();
    return rows.map((r) => ({
      kind: r.kind,
      balance: Money.of(r.currency as CurrencyCode, BigInt(r.balance_minor)),
    }));
  }

  /**
   * @function page
   * @description Keyset page on `postings (user_id, id DESC)`: `id < beforeId`, newest first, joined to `journals` by primary key. The cost is the same on page 1 and page 1,000, because nothing is skipped (no OFFSET).
   * @param tx - a read transaction
   * @param userId - the wallet owner
   * @param beforeId - only postings older than this id; omit for the first page
   * @param take - rows to fetch
   * @returns the postings, newest first
   */
  async page(
    tx: Tx,
    userId: string,
    beforeId: bigint | undefined,
    take: number,
  ): Promise<HistoryEntry[]> {
    let q = db(tx)
      .selectFrom('postings as p')
      .innerJoin('journals as j', 'j.id', 'p.journal_id')
      .select([
        'p.id',
        'p.journal_id',
        'j.kind',
        'p.account_kind',
        'p.currency',
        'p.amount_minor',
        'p.balance_after_minor',
        'j.ref_type',
        'j.ref_id',
        'j.description',
        'p.created_at',
      ])
      .where('p.user_id', '=', userId);
    if (beforeId !== undefined) {
      q = q.where('p.id', '<', beforeId.toString());
    }
    const rows = await q.orderBy('p.id', 'desc').limit(take).execute();

    return rows.map((r) => {
      const currency = r.currency as CurrencyCode;
      return {
        postingId: BigInt(r.id),
        journalId: BigInt(r.journal_id),
        journalKind: r.kind as JournalKind,
        bucket: r.account_kind as HistoryEntry['bucket'],
        amount: Money.of(currency, BigInt(r.amount_minor)),
        balanceAfter: Money.of(currency, BigInt(r.balance_after_minor)),
        refType: r.ref_type,
        refId: r.ref_id,
        description: r.description,
        createdAt: r.created_at,
      };
    });
  }
}
