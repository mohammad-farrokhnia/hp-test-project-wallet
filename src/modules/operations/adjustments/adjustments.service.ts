import { Injectable } from '@nestjs/common';
import { uuidv7 } from '../../../common/ids';
import { apiCurrencyCode, formatApiAmount, Money } from '../../../common/money';
import { TransactionRunner } from '../../../database/transaction-runner';
import { IdempotencyService, StoredResponse } from '../../idempotency';
import { LedgerService } from '../../ledger';
import { AdjustmentsRepository } from './adjustments.repository';

export const ADJUSTMENTS_SCOPE = 'POST /internal/adjustments';

export interface CreateAdjustment {
  readonly userId: string;
  readonly amount: Money;
  readonly reason: string;
  readonly actor: string | null;
  readonly body: unknown;
}

export interface AdjustmentReply {
  readonly response: StoredResponse;
  readonly replayed: boolean;
}

/**
 * @class AdjustmentsService
 * @description Manual credit by an operator. One transaction: claim the key, credit the user through the ledger (one `ADJUSTMENT_CREDIT` journal, DEBT first), record the adjustment, store the response. A replay with the same key adds nothing and returns the first response.
 */
@Injectable()
export class AdjustmentsService {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly idempotency: IdempotencyService,
    private readonly ledger: LedgerService,
    private readonly adjustments: AdjustmentsRepository,
  ) {}

  /**
   * @function create
   * @param cmd - the parsed request
   * @param key - the Idempotency-Key
   * @returns the 201 response, fresh or replayed
   * @throws {AppError} `IDEMPOTENCY_KEY_REUSED` (422), `IDEMPOTENCY_IN_PROGRESS` (409)
   */
  create(cmd: CreateAdjustment, key: string): Promise<AdjustmentReply> {
    return this.runner.run(async (tx) => {
      const claim = await this.idempotency.claim(tx, {
        key,
        scope: ADJUSTMENTS_SCOPE,
        body: cmd.body,
      });
      if (claim.kind === 'REPLAY') {
        return { response: claim.response, replayed: true };
      }

      const adjustmentId = uuidv7();
      const { journalId } = await this.ledger.creditUser(tx, {
        userId: cmd.userId,
        amount: cmd.amount,
        source: 'OPS_ADJUSTMENTS',
        kind: 'ADJUSTMENT_CREDIT',
        refId: adjustmentId,
        description: `Adjustment: ${cmd.reason}`,
      });
      await this.adjustments.insert(tx, {
        id: adjustmentId,
        userId: cmd.userId,
        amount: cmd.amount,
        reason: cmd.reason,
        actor: cmd.actor,
        journalId,
      });

      const response: StoredResponse = {
        status: 201,
        body: {
          adjustmentId,
          journalId: journalId.toString(),
          userId: cmd.userId,
          currency: apiCurrencyCode(cmd.amount),
          amount: formatApiAmount(cmd.amount),
        },
      };
      await this.idempotency.complete(tx, key, response, {
        type: 'ADJUSTMENT',
        id: adjustmentId,
      });
      return { response, replayed: false };
    });
  }
}
