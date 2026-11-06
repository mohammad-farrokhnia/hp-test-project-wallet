import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '../../common/errors';
import { uuidv7 } from '../../common/ids';
import { Money } from '../../common/money';
import { TransactionRunner, Tx } from '../../database/transaction-runner';
import { IdempotencyService, StoredResponse } from '../idempotency';
import { creditLines, LedgerService } from '../ledger';
import { TransfersRepository } from './transfers.repository';

export const TRANSFERS_SCOPE = 'POST /transfers';

export interface RequestTransfer {
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly amount: Money;
  readonly body: unknown;
}

export interface TransferReply {
  readonly response: StoredResponse;
  readonly replayed: boolean;
}

/**
 * @class TransferService
 * @description `POST /transfers`: moves money from one user's AVAILABLE to another's, atomically. Before the transaction, not stored: 422 `SAME_USER`.
 * Then ONE transaction, in the global lock order:
 * 1. claim the Idempotency-Key (a repeat replays; another body is 422 `IDEMPOTENCY_KEY_REUSED`);
 * 2. `LedgerService.lockUsersAccounts`: both users' accounts, locked in one ascending-id statement, so opposite transfers can never deadlock;
 * 3. the sender must hold the amount and owe nothing, else a stored 422 `INSUFFICIENT_FUNDS`;
 * 4. one `TRANSFER` journal: sender AVAILABLE −x, receiver credited through `creditLines` (their DEBT is paid off first, as for every credit);
 * 5. the `transfers` row, the stored 201, commit. The ledger writes the balance events of both users in the same transaction.
 */
@Injectable()
export class TransferService {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly idempotency: IdempotencyService,
    private readonly ledger: LedgerService,
    private readonly transfers: TransfersRepository,
  ) {}

  /**
   * @function request
   * @param cmd - the parsed request
   * @param key - the Idempotency-Key
   * @returns the response, fresh or replayed
   * @throws {AppError} `SAME_USER`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`
   */
  async request(cmd: RequestTransfer, key: string): Promise<TransferReply> {
    if (cmd.fromUserId === cmd.toUserId) throw new AppError('SAME_USER');

    return this.runner.run(async (tx) => {
      const claim = await this.idempotency.claim(tx, {
        key,
        scope: TRANSFERS_SCOPE,
        body: cmd.body,
      });
      if (claim.kind === 'REPLAY') {
        return { response: claim.response, replayed: true };
      }

      const users = await this.ledger.lockUsersAccounts(
        tx,
        [cmd.fromUserId, cmd.toUserId],
        cmd.amount.currency,
      );
      const sender = users.get(cmd.fromUserId);
      const receiver = users.get(cmd.toUserId);
      if (!sender || !receiver) throw new Error('transfer accounts missing');

      if (sender.debt.isNegative() || sender.available.lt(cmd.amount)) {
        return this.reply(tx, key, rejection('INSUFFICIENT_FUNDS'));
      }

      const id = uuidv7();
      const { journalId } = await this.ledger.post(tx, {
        kind: 'TRANSFER',
        refId: id,
        currency: cmd.amount.currency,
        description: `Transfer ${id}`,
        lines: [
          { accountId: sender.ids.available, amount: cmd.amount.negate() },
          ...creditLines(
            {
              availableId: receiver.ids.available,
              debtId: receiver.ids.debt,
              debt: receiver.debt,
            },
            cmd.amount,
          ),
        ],
      });
      await this.transfers.insert(tx, {
        id,
        fromUserId: cmd.fromUserId,
        toUserId: cmd.toUserId,
        amount: cmd.amount,
        journalId,
      });
      return this.reply(tx, key, { status: 201, body: { transferId: id } }, id);
    });
  }

  /** Stores the response on the key and returns it. */
  private async reply(
    tx: Tx,
    key: string,
    response: StoredResponse,
    transferId?: string,
  ): Promise<TransferReply> {
    await this.idempotency.complete(
      tx,
      key,
      response,
      transferId ? { type: 'TRANSFER', id: transferId } : undefined,
    );
    return { response, replayed: false };
  }
}

function rejection(code: ErrorCode): StoredResponse {
  const err = new AppError(code);
  return { status: err.status, body: err.toBody() };
}
