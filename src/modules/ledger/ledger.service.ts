import { Injectable } from '@nestjs/common';
import { CurrencyCode } from '../../common/money';
import { Tx } from '../../database/transaction-runner';
import { UserAccountIds } from './ledger.types';
import { AccountsRepository } from './repositories/accounts.repository';

/**
 * @class LedgerService
 * @description The ledger's public door: the only code that reads or writes accounts, journals and postings.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly accounts: AccountsRepository) {}

  /**
   * @function ensureUserAccounts
   * @description Get-or-create a user's AVAILABLE, FROZEN and DEBT accounts in one currency. Safe under concurrency: the unique key `(user_id, kind, currency)` is the arbiter, so any number of simultaneous first uses end with exactly one account set. Reads first, so the common case writes nothing and burns no identity values.
   * @param tx - the caller's transaction
   * @param userId - the wallet owner (`^[A-Za-z0-9_-]{1,64}$`)
   * @param currency - `IRR` or `USDT`
   * @returns the three account ids
   */
  async ensureUserAccounts(
    tx: Tx,
    userId: string,
    currency: CurrencyCode,
  ): Promise<UserAccountIds> {
    const existing = await this.accounts.findUserAccounts(tx, userId, currency);
    if (existing) return existing;

    await this.accounts.insertMissingUserAccounts(tx, userId, currency);
    const created = await this.accounts.findUserAccounts(tx, userId, currency);
    if (!created) {
      throw new Error(
        `accounts for user ${userId} (${currency}) are missing after insert`,
      );
    }
    return created;
  }
}
