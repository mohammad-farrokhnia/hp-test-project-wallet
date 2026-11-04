import { Injectable } from '@nestjs/common';
import { CurrencyCode } from '../../../common/money';
import { Tx } from '../../../database/transaction-runner';
import { UserAccountIds } from '../ledger.types';

interface AccountRow {
  id: string;
  kind: string;
}

/**
 * @class AccountsRepository
 * @description Explicit SQL over `accounts`. Owned by the ledger module; nothing else imports it.
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
    const rows = await tx.query<AccountRow[]>(
      `SELECT id, kind FROM accounts
        WHERE user_id = $1 AND currency = $2 AND owner_type = 'USER'`,
      [userId, currency],
    );
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
    await tx.query(
      `INSERT INTO accounts (owner_type, user_id, kind, currency)
       SELECT 'USER', $1, k.kind, $2
         FROM unnest(ARRAY['AVAILABLE', 'FROZEN', 'DEBT']) WITH ORDINALITY AS k(kind, ord)
        ORDER BY k.ord
       ON CONFLICT ON CONSTRAINT accounts_owner_key DO NOTHING`,
      [userId, currency],
    );
  }
}
