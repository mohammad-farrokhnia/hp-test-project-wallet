import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { CurrencyCode, Money } from '../../../common/money';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';
import { ViolationRow as Row } from '../domain/invariants';
import { FrozenBalance } from '../ledger.types';

/**
 * @class LedgerChecksRepository
 * @description Read-only queries that prove the ledger is consistent. Each returns at most `limit` offending rows, every value as text. Full scans by design: the checker runs every few minutes, never on a request path.
 */
@Injectable()
export class LedgerChecksRepository {
  /**
   * @function unbalancedJournals
   * @description Journals whose postings do not sum to zero, have fewer than two postings, or mix currencies. The deferred trigger refuses these at commit;
   */
  async unbalancedJournals(tx: Tx, limit: number): Promise<Row[]> {
    const { rows } = await sql<Row>`
      SELECT j.id::text                                             AS journal_id,
             j.kind,
             j.currency,
             COALESCE(sum(p.amount_minor), 0)::text                 AS sum_minor,
             count(p.id)::text                                      AS postings,
             count(*) FILTER (WHERE p.currency <> j.currency)::text AS foreign_currency_postings
        FROM journals j
        LEFT JOIN postings p ON p.journal_id = j.id
       GROUP BY j.id
      HAVING COALESCE(sum(p.amount_minor), 0) <> 0
          OR count(p.id) < 2
          OR count(*) FILTER (WHERE p.currency <> j.currency) > 0
       ORDER BY j.id
       LIMIT ${limit}`.execute(db(tx));
    return rows;
  }

  /**
   * @function balancesDifferingFromPostings
   * @description Accounts whose balance is not the sum of their postings, or not the `balance_after` of their latest posting.
   */
  async balancesDifferingFromPostings(tx: Tx, limit: number): Promise<Row[]> {
    const { rows } = await sql<Row>`
      SELECT a.id::text                          AS account_id,
             a.user_id,
             a.kind,
             a.currency,
             a.balance_minor::text               AS balance_minor,
             COALESCE(s.total, 0)::text          AS postings_sum_minor,
             last.balance_after_minor::text      AS last_balance_after_minor
        FROM accounts a
        LEFT JOIN (SELECT account_id, sum(amount_minor) AS total
                     FROM postings GROUP BY account_id) s ON s.account_id = a.id
        LEFT JOIN LATERAL (SELECT p.balance_after_minor
                             FROM postings p
                            WHERE p.account_id = a.id
                            ORDER BY p.id DESC
                            LIMIT 1) last ON true
       WHERE a.balance_minor <> COALESCE(s.total, 0)
          OR last.balance_after_minor <> a.balance_minor
       ORDER BY a.id
       LIMIT ${limit}`.execute(db(tx));
    return rows;
  }

  /**
   * @function negativeBalances
   * @description Protected accounts below zero and DEBT accounts above zero. Both are refused by CHECK constraints; this reports them if a constraint is ever dropped.
   */
  async negativeBalances(tx: Tx, limit: number): Promise<Row[]> {
    const { rows } = await sql<Row>`
      SELECT id::text            AS account_id,
             user_id,
             kind,
             currency,
             balance_minor::text AS balance_minor
        FROM accounts
       WHERE (NOT allow_negative AND balance_minor < 0)
          OR (kind = 'DEBT' AND balance_minor > 0)
       ORDER BY id
       LIMIT ${limit}`.execute(db(tx));
    return rows;
  }

  /**
   * @function availableWithDebt
   * @description Users holding AVAILABLE money while in DEBT. Incoming money pays debt first, so this should never happen.
   */
  async availableWithDebt(tx: Tx, limit: number): Promise<Row[]> {
    const { rows } = await sql<Row>`
      SELECT av.user_id,
             av.currency,
             av.balance_minor::text AS available_minor,
             d.balance_minor::text  AS debt_minor
        FROM accounts av
        JOIN accounts d
          ON d.user_id = av.user_id AND d.currency = av.currency AND d.kind = 'DEBT'
       WHERE av.kind = 'AVAILABLE'
         AND av.balance_minor > 0
         AND d.balance_minor < 0
       ORDER BY av.user_id, av.currency
       LIMIT ${limit}`.execute(db(tx));
    return rows;
  }

  /**
   * @function nonZeroFrozenBalances
   * @param tx - the caller's transaction
   * @returns every user FROZEN account holding money
   */
  async nonZeroFrozenBalances(tx: Tx): Promise<FrozenBalance[]> {
    const rows = await db(tx)
      .selectFrom('accounts')
      .select(['user_id', 'currency', 'balance_minor'])
      .where('kind', '=', 'FROZEN')
      .where('balance_minor', '<>', '0')
      .orderBy('user_id')
      .orderBy('currency')
      .execute();
    return rows.map((r) => ({
      userId: r.user_id ?? '',
      balance: Money.of(r.currency as CurrencyCode, BigInt(r.balance_minor)),
    }));
  }
}
