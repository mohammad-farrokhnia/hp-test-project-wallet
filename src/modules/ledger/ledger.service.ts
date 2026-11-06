import { Injectable } from '@nestjs/common';
import { CurrencyCode } from '../../common/money';
import { foldBalances } from './domain/balances';
import { Tx } from '../../database/transaction-runner';
import { BALANCE_CHANGED, EVENTS_EXCHANGE, OutboxService } from '../messaging';
import {
  JournalInput,
  planPostings,
  SystemAccountKind,
  validateJournal,
} from './domain/journal';
import {
  INVARIANT_VIOLATION_LIMIT,
  InvariantCheck,
  toInvariantCheck,
} from './domain/invariants';
import { creditLines } from './domain/credit';
import { LedgerError } from './domain/ledger.error';
import {
  CreditUserInput,
  FrozenBalance,
  HistoryPage,
  LockedUserAccounts,
  PostResult,
  UserAccountIds,
  WalletBalances,
} from './ledger.types';
import { AccountsRepository } from './repositories/accounts.repository';
import { HistoryRepository } from './repositories/history.repository';
import { JournalsRepository } from './repositories/journals.repository';
import { LedgerChecksRepository } from './repositories/ledger-checks.repository';

/**
 * @class LedgerService
 * @description The ledger's public door: the only code that reads or writes accounts, journals and postings, and the only writer of money.
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly journals: JournalsRepository,
    private readonly checks: LedgerChecksRepository,
    private readonly history: HistoryRepository,
    private readonly outbox: OutboxService,
  ) {}

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

  /**
   * @function lockUserAccounts
   * @description Creates the user's accounts on first use, then locks all three in id order and reads their balances, so a funds check sees the newest committed values and holds them until commit.
   * `post` on the same rows later does not wait.
   * @param tx - the caller's transaction
   * @param userId - the wallet owner
   * @param currency - `IRR` or `USDT`
   * @returns ids and locked balances
   */
  async lockUserAccounts(
    tx: Tx,
    userId: string,
    currency: CurrencyCode,
  ): Promise<LockedUserAccounts> {
    const ids = await this.ensureUserAccounts(tx, userId, currency);
    const locked = await this.accounts.lockAccountsById(tx, [
      ids.available,
      ids.frozen,
      ids.debt,
    ]);
    const balance = (id: bigint) => {
      const a = locked.get(id);
      if (!a)
        throw new LedgerError('ACCOUNT_NOT_FOUND', `account ${id} vanished`);
      return a.balance;
    };
    return {
      ids,
      available: balance(ids.available),
      frozen: balance(ids.frozen),
      debt: balance(ids.debt),
    };
  }

  /**
   * @function lockUsersAccounts
   * @description For an operation that moves money between users: creates each user's accounts on first use,
   * then locks every account of all of them in ONE ascending-id statement and reads the balances.
   * That single global order is what keeps two opposite-direction operations from deadlocking:
   * both wait on the same first row instead of each holding what the other needs. Accounts are created in sorted user order for the same reason.
   * @param tx - the caller's transaction
   * @param userIds - the users involved, in any order
   * @param currency - `IRR` or `USDT`
   * @returns each user's ids and locked balances
   */
  async lockUsersAccounts(
    tx: Tx,
    userIds: readonly string[],
    currency: CurrencyCode,
  ): Promise<Map<string, LockedUserAccounts>> {
    const users = [...new Set(userIds)].sort();
    const idsOf = new Map<string, UserAccountIds>();
    for (const userId of users) {
      idsOf.set(userId, await this.ensureUserAccounts(tx, userId, currency));
    }
    const locked = await this.accounts.lockAccountsById(
      tx,
      [...idsOf.values()].flatMap((i) => [i.available, i.frozen, i.debt]),
    );
    const balance = (id: bigint) => {
      const a = locked.get(id);
      if (!a)
        throw new LedgerError('ACCOUNT_NOT_FOUND', `account ${id} vanished`);
      return a.balance;
    };
    return new Map(
      users.map((userId) => {
        const ids = idsOf.get(userId) as UserAccountIds;
        return [
          userId,
          {
            ids,
            available: balance(ids.available),
            frozen: balance(ids.frozen),
            debt: balance(ids.debt),
          },
        ];
      }),
    );
  }

  /**
   * @function systemAccountId
   * @param tx - the caller's transaction
   * @param kind - `PSP_CLEARING`, `PAYOUT_CLEARING`, `FEE_REVENUE` or `OPS_ADJUSTMENTS`
   * @param currency - `IRR` or `USDT`
   * @returns the seeded system account's id
   * @throws {LedgerError} `ACCOUNT_NOT_FOUND` if the seed migration did not run
   */
  async systemAccountId(
    tx: Tx,
    kind: SystemAccountKind,
    currency: CurrencyCode,
  ): Promise<bigint> {
    const id = await this.accounts.findSystemAccountId(tx, kind, currency);
    if (id === null) {
      throw new LedgerError(
        'ACCOUNT_NOT_FOUND',
        `system account ${kind} ${currency} is not seeded`,
      );
    }
    return id;
  }

  /**
   * @function creditUser
   * @description Books one credit journal: the source system account gives `amount`, and the user receives it through `creditLines`, DEBT first. Creates the user's accounts on first use. Locks the user's AVAILABLE and DEBT and the source in id order before reading the debt, so the split is computed on the balances `post` will update.
   * @param tx - the caller's transaction
   * @param credit - who, how much, from which system account, and the journal's kind and ref
   * @returns the journal id and whether it was already booked
   * @throws {LedgerError} `INVALID_JOURNAL` for a non-positive amount, `ACCOUNT_NOT_FOUND`
   */
  async creditUser(tx: Tx, credit: CreditUserInput): Promise<PostResult> {
    const { userId, amount } = credit;
    const user = await this.ensureUserAccounts(tx, userId, amount.currency);
    const sourceId = await this.systemAccountId(
      tx,
      credit.source,
      amount.currency,
    );
    const locked = await this.accounts.lockAccountsById(tx, [
      user.available,
      user.debt,
      sourceId,
    ]);
    const debt = locked.get(user.debt);
    if (!debt) {
      throw new LedgerError('ACCOUNT_NOT_FOUND', `DEBT of ${userId} vanished`);
    }

    return this.post(tx, {
      kind: credit.kind,
      refId: credit.refId,
      currency: amount.currency,
      description: credit.description,
      lines: [
        { accountId: sourceId, amount: amount.negate() },
        ...creditLines(
          {
            availableId: user.available,
            debtId: user.debt,
            debt: debt.balance,
          },
          amount,
        ),
      ],
    });
  }

  /**
   * @function post
   * @description Books one journal, all inside the caller's transaction:
   * 1. validate the lines (non-zero, one currency, sum zero) before taking any lock;
   * 2. lock every account in ascending id order;
   * 3. insert the journal; if `(kind, ref)` is already booked, stop and return it;
   * 4. compute each balance after and refuse a protected balance below zero;
   * 5. append the postings with `balance_after`, then update the balances;
   * 6. write one `wallet.balance.changed` outbox event per user whose balance this journal changed, in the same transaction (a duplicate booking writes none).
   * Locks come before the journal insert so a duplicate waits on the account lock instead of holding one, which keeps the lock order intact.
   * @param tx - the caller's transaction
   * @param journal - the event to book
   * @returns the journal id and whether it was already booked
   * @throws {LedgerError} `INVALID_JOURNAL`, `ACCOUNT_NOT_FOUND`, `INSUFFICIENT_BALANCE`
   */
  async post(tx: Tx, journal: JournalInput): Promise<PostResult> {
    validateJournal(journal);

    const ids = journal.lines.map((l) => l.accountId);
    const locked = await this.accounts.lockAccountsById(tx, ids);

    const journalId = await this.journals.insertJournal(tx, journal);
    if (journalId === null) {
      return {
        journalId: await this.journals.findJournalId(tx, journal),
        alreadyBooked: true,
      };
    }

    const postings = planPostings(journal, locked);
    await this.journals.insertPostings(tx, journalId, postings);
    for (const p of postings) {
      await this.accounts.setBalance(tx, p.account.id, p.balanceAfter);
    }
    await this.announceBalanceChanges(tx, journal, journalId, postings);
    return { journalId, alreadyBooked: false };
  }

  /**
   * @function announceBalanceChanges
   * @description The outbox event for every balance change: one per user per journal, written in the journal's own transaction,
   * so it exists exactly when the money moved. Ids only: the consumer reloads the balances. System accounts have no owner and announce nothing.
   */
  private async announceBalanceChanges(
    tx: Tx,
    journal: JournalInput,
    journalId: bigint,
    postings: readonly {
      readonly account: { readonly userId: string | null };
    }[],
  ): Promise<void> {
    const users = new Set<string>();
    for (const p of postings) {
      if (p.account.userId !== null) users.add(p.account.userId);
    }
    for (const userId of [...users].sort()) {
      await this.outbox.add(tx, {
        exchange: EVENTS_EXCHANGE,
        routingKey: BALANCE_CHANGED,
        aggregate: { type: 'WALLET', id: userId },
        payload: {
          userId,
          currency: journal.currency,
          journalId: journalId.toString(),
          kind: journal.kind,
        },
      });
    }
  }

  /**
   * @function getBalances
   * @description A user's balances in every currency. Reads only: no locks, and an unknown user gets zeros without any account being created (A3).
   * @param tx - a read transaction
   * @param userId - the wallet owner
   * @returns balances per currency, in registry order
   */
  async getBalances(
    tx: Tx,
    userId: string,
  ): Promise<Map<CurrencyCode, WalletBalances>> {
    return foldBalances(await this.history.userBalances(tx, userId));
  }

  /**
   * @function listHistory
   * @description One page of a user's postings, newest first, by keyset on the posting id. Fetches one extra row to know whether another page follows.
   * @param tx - a read transaction
   * @param userId - the wallet owner
   * @param page - `beforeId` from the previous page (omit for the first), and the page size
   * @returns the entries and the `beforeId` of the next page, or `null`
   */
  async listHistory(
    tx: Tx,
    userId: string,
    page: { beforeId?: bigint; limit: number },
  ): Promise<HistoryPage> {
    const rows = await this.history.page(
      tx,
      userId,
      page.beforeId,
      page.limit + 1,
    );
    const entries = rows.slice(0, page.limit);
    const more = rows.length > page.limit;
    return {
      entries,
      nextBeforeId: more ? entries[entries.length - 1].postingId : null,
    };
  }

  /**
   * @function checkLedger
   * @description The ledger's own invariants: every journal sums to zero; every balance equals the sum of its postings and its latest `balance_after`; no protected balance below zero; no AVAILABLE money while in DEBT. Run it in a REPEATABLE READ transaction so all checks see one snapshot.
   * @param tx - a (read-only) transaction
   * @returns one result per invariant
   */
  async checkLedger(tx: Tx): Promise<InvariantCheck[]> {
    const limit = INVARIANT_VIOLATION_LIMIT + 1;
    const c = this.checks;
    return [
      toInvariantCheck('ZERO_SUM', await c.unbalancedJournals(tx, limit)),
      toInvariantCheck(
        'BALANCE_EQUALS_POSTINGS',
        await c.balancesDifferingFromPostings(tx, limit),
      ),
      toInvariantCheck(
        'NO_NEGATIVE_BALANCES',
        await c.negativeBalances(tx, limit),
      ),
      toInvariantCheck(
        'AVAILABLE_ONLY_WITHOUT_DEBT',
        await c.availableWithDebt(tx, limit),
      ),
    ];
  }

  /**
   * @function frozenBalances
   * @param tx - the caller's transaction
   * @returns every user FROZEN balance that is not zero, by user and currency
   */
  frozenBalances(tx: Tx): Promise<FrozenBalance[]> {
    return this.checks.nonZeroFrozenBalances(tx);
  }
}
