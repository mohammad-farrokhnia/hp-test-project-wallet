import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { CurrencyCode, Money } from '../../../common/money';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';
import {
  AccountKind,
  LockedAccount,
  SystemAccountKind,
} from '../domain/journal';
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
   * @function lockAccountsById
   * @description `SELECT … FOR UPDATE` in ascending id order: rows are locked in the order the sort returns them, so two journals touching the same accounts can never wait on each other in a cycle. Rows this transaction already holds are re-read without waiting.
   * @param tx - the caller's transaction
   * @param ids - account ids, any order, no duplicates needed
   * @returns the locked accounts, by id; missing ids are absent
   */
  async lockAccountsById(
    tx: Tx,
    ids: readonly bigint[],
  ): Promise<Map<bigint, LockedAccount>> {
    const rows = await db(tx)
      .selectFrom('accounts')
      .select([
        'id',
        'user_id',
        'kind',
        'currency',
        'balance_minor',
        'allow_negative',
      ])
      .where(
        'id',
        'in',
        ids.map((id) => id.toString()),
      )
      .orderBy('id')
      .forUpdate()
      .execute();

    return new Map(
      rows.map((r) => {
        const currency = r.currency as CurrencyCode;
        const account: LockedAccount = {
          id: BigInt(r.id),
          userId: r.user_id,
          kind: r.kind as AccountKind,
          currency,
          balance: Money.of(currency, BigInt(r.balance_minor)),
          allowNegative: r.allow_negative === true,
        };
        return [account.id, account];
      }),
    );
  }

  /**
   * @function setBalance
   * @description Writes a balance computed under this transaction's row lock.
   * @param tx - the caller's transaction, holding the row lock
   * @param accountId - the account
   * @param balance - the new balance
   */
  async setBalance(tx: Tx, accountId: bigint, balance: Money): Promise<void> {
    await db(tx)
      .updateTable('accounts')
      .set({ balance_minor: balance.minor })
      .where('id', '=', accountId.toString())
      .execute();
  }

  /**
   * @function findSystemAccountId
   * @param tx - the caller's transaction
   * @param kind - the system account kind
   * @param currency - `IRR` or `USDT`
   * @returns the account id, or `null` if the seed is missing
   */
  async findSystemAccountId(
    tx: Tx,
    kind: SystemAccountKind,
    currency: CurrencyCode,
  ): Promise<bigint | null> {
    const row = await db(tx)
      .selectFrom('accounts')
      .select('id')
      .where('owner_type', '=', 'SYSTEM')
      .where('kind', '=', kind)
      .where('currency', '=', currency)
      .executeTakeFirst();
    return row ? BigInt(row.id) : null;
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
