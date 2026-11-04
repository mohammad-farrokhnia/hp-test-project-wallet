import { Injectable } from '@nestjs/common';
import { Money } from '../../../common/money';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';

export interface NewAdjustment {
  readonly id: string;
  readonly userId: string;
  readonly amount: Money;
  readonly reason: string;
  readonly actor: string | null;
  readonly journalId: bigint;
}

/**
 * @class AdjustmentsRepository
 * @description Explicit SQL over `adjustments`. Owned by the operations module.
 */
@Injectable()
export class AdjustmentsRepository {
  async insert(tx: Tx, a: NewAdjustment): Promise<void> {
    await db(tx)
      .insertInto('adjustments')
      .values({
        id: a.id,
        user_id: a.userId,
        currency: a.amount.currency,
        amount_minor: a.amount.minor,
        reason: a.reason,
        actor: a.actor,
        journal_id: a.journalId,
      })
      .execute();
  }
}
