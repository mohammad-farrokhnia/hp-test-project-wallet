import { Injectable } from '@nestjs/common';
import { CurrencyCode, Money } from '../../common/money';
import { db } from '../../database/kysely';
import { Tx } from '../../database/transaction-runner';

export interface NewNotification {
  readonly messageId: string;
  readonly userId: string;
  readonly currency: CurrencyCode;
  readonly journalId: bigint;
  readonly available: Money;
  readonly frozen: Money;
  readonly debt: Money;
}

export interface NotificationRecord {
  readonly messageId: string;
  readonly userId: string;
  readonly kind: 'BALANCE_CHANGED';
  readonly currency: CurrencyCode;
  readonly journalId: bigint;
  readonly available: Money;
  readonly frozen: Money;
  readonly debt: Money;
}

/**
 * @class NotificationsRepository
 * @description Explicit SQL over `notifications`. Owned by the notification module.
 */
@Injectable()
export class NotificationsRepository {
  /** Records that a user was told their balance changed, with the balances as read when the message was handled. */
  async insert(tx: Tx, n: NewNotification): Promise<void> {
    await db(tx)
      .insertInto('notifications')
      .values({
        message_id: n.messageId,
        user_id: n.userId,
        kind: 'BALANCE_CHANGED',
        currency: n.currency,
        journal_id: n.journalId,
        available_minor: n.available.minor,
        frozen_minor: n.frozen.minor,
        debt_minor: n.debt.minor,
      })
      .execute();
  }

  /** @returns a user's notifications, oldest first */
  async listForUser(tx: Tx, userId: string): Promise<NotificationRecord[]> {
    const rows = await db(tx)
      .selectFrom('notifications')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('id')
      .execute();
    return rows.map((r) => {
      const currency = r.currency as CurrencyCode;
      return {
        messageId: r.message_id,
        userId: r.user_id,
        kind: 'BALANCE_CHANGED',
        currency,
        journalId: BigInt(r.journal_id),
        available: Money.of(currency, BigInt(r.available_minor)),
        frozen: Money.of(currency, BigInt(r.frozen_minor)),
        debt: Money.of(currency, BigInt(r.debt_minor)),
      };
    });
  }
}
