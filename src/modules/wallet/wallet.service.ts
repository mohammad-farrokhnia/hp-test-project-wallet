import { Injectable } from '@nestjs/common';
import { Tx, TransactionRunner } from '../../database/transaction-runner';
import { LedgerService } from '../ledger';
import { decodeCursor } from './domain/history-query';
import {
  HistoryResponse,
  toHistoryResponse,
  toWalletResponse,
  WalletResponse,
} from './wallet.mapper';

/** Read-only transactions: a wallet read can never write, and never creates accounts. */
const READ = { readOnly: true } as const;

/**
 * @class WalletService
 * @description Balances and history. Owns no tables: everything comes from the ledger.
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * @function getWallet
   * @param userId - the wallet owner, already validated
   * @returns IRT and USDT balances; zeros for an unknown user, with no row created
   */
  getWallet(userId: string): Promise<WalletResponse> {
    return this.runner.run(
      async (tx) =>
        toWalletResponse(userId, await this.ledger.getBalances(tx, userId)),
      READ,
    );
  }

  /**
   * @function getHistory
   * @param userId - the wallet owner, already validated
   * @param query - `cursor` from the previous page, `limit` already checked (1–100)
   * @returns one page, newest first
   * @throws {AppError} `INVALID_CURSOR` (400)
   */
  getHistory(
    userId: string,
    query: { cursor?: string; limit: number },
  ): Promise<HistoryResponse> {
    const beforeId =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    return this.runner.run(
      (tx) => this.historyIn(tx, userId, beforeId, query.limit),
      READ,
    );
  }

  /** The page itself, on the caller's transaction (the performance test seeds and reads in one). */
  async historyIn(
    tx: Tx,
    userId: string,
    beforeId: bigint | undefined,
    limit: number,
  ): Promise<HistoryResponse> {
    return toHistoryResponse(
      await this.ledger.listHistory(tx, userId, { beforeId, limit }),
    );
  }
}
