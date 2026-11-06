import { Injectable } from '@nestjs/common';
import { CurrencyCode, Money } from '../../common/money';
import { db } from '../../database/kysely';
import { Tx } from '../../database/transaction-runner';

export interface NewTransfer {
  readonly id: string;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly amount: Money;
  readonly journalId: bigint;
}

export interface TransferRecord {
  readonly id: string;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly amount: Money;
  readonly journalId: bigint;
  readonly createdAt: Date;
}

/**
 * @class TransfersRepository
 * @description Explicit SQL over `transfers`. Owned by the transfer module.
 */
@Injectable()
export class TransfersRepository {
  async insert(tx: Tx, t: NewTransfer): Promise<void> {
    await db(tx)
      .insertInto('transfers')
      .values({
        id: t.id,
        from_user_id: t.fromUserId,
        to_user_id: t.toUserId,
        currency: t.amount.currency,
        amount_minor: t.amount.minor,
        journal_id: t.journalId,
      })
      .execute();
  }

  /** @returns the transfer, or `null` */
  async findById(tx: Tx, id: string): Promise<TransferRecord | null> {
    const r = await db(tx)
      .selectFrom('transfers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) return null;
    return {
      id: r.id,
      fromUserId: r.from_user_id,
      toUserId: r.to_user_id,
      amount: Money.of(r.currency as CurrencyCode, BigInt(r.amount_minor)),
      journalId: BigInt(r.journal_id),
      createdAt: r.created_at,
    };
  }
}
