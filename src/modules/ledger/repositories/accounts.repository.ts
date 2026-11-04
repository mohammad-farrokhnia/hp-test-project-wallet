import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { CurrencyCode } from '../../../common/money';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';
import { UserAccountIds } from '../ledger.types';

/** Insert order is lock order: every caller locks a user's accounts in this sequence. */
const USER_ACCOUNT_KINDS = ['AVAILABLE', 'FROZEN', 'DEBT'] as const;

/**
 * @class AccountsRepository
 * @description Explicit, typed SQL over `accounts`. Owned by the ledger module; nothing else imports it.
 */
@Injectable()
export class AccountsRepository {
  /**
   * @function findUserAccounts
   * @param tx - the caller's transaction
   * @param userId - the wallet owner
   * @param currency - `IRR` or `USDT`
   * @returns the user's three account ids, or `null` if any is missing
   */
  async findUserAccounts(
    tx: Tx,
    userId: string,
    currency: CurrencyCode,
  ): Promise<UserAccountIds | null> {
    const rows = await db(tx)
      .selectFrom('accounts')
      .select(['id', 'kind'])
      .where('user_id', '=', userId)
      .where('currency', '=', currency)
      .where('owner_type', '=', 'USER')
      .execute();

    const byKind = new Map(rows.map((r) => [r.kind, BigInt(r.id)]));
    const available = byKind.get('AVAILABLE');
    const frozen = byKind.get('FROZEN');
    const debt = byKind.get('DEBT');
    if (available === undefined || frozen === undefined || debt === undefined) {
      return null;
    }
    return { available, frozen, debt };
  }

  /**
   * @function insertMissingUserAccounts
   * @description Inserts whichever of the user's three accounts do not exist yet, always in the same kind order. A concurrent insert of the same row makes this statement wait for that transaction, then skip the row.
   * @param tx - the caller's transaction
   * @param userId - the wallet owner
   * @param currency - `IRR` or `USDT`
   */
  async insertMissingUserAccounts(
    tx: Tx,
    userId: string,
    currency: CurrencyCode,
  ): Promise<void> {
    await db(tx)
      .insertInto('accounts')
      .columns(['owner_type', 'user_id', 'kind', 'currency'])
      .expression(
        sql`SELECT 'USER', ${userId}, k.kind, ${currency}
              FROM unnest(${sql.val(USER_ACCOUNT_KINDS)}::text[]) WITH ORDINALITY AS k(kind, ord)
             ORDER BY k.ord`,
      )
      .onConflict((oc) => oc.constraint('accounts_owner_key').doNothing())
      .execute();
  }
}
