import { Injectable, Logger } from '@nestjs/common';
import { CURRENCIES, CurrencyCode } from '../../common/money';
import { TransactionRunner } from '../../database/transaction-runner';
import { LedgerService } from '../ledger';
import {
  BALANCE_CHANGED,
  Envelope,
  InboxService,
  JobHandler,
} from '../messaging';
import { NotificationsRepository } from './notifications.repository';

/** The inbox name of this consumer: message ids are de-duplicated per consumer. */
export const NOTIFICATION_CONSUMER = 'notification';

interface BalanceChange {
  readonly userId: string;
  readonly currency: CurrencyCode;
  readonly journalId: bigint;
}

/**
 * @class NotificationHandler
 * @description Consumer of `notify.events`. For each `wallet.balance.changed` message, in ONE transaction:
 * 1. `InboxService.markProcessed`: a message this consumer already handled stops here, so a duplicate delivery changes nothing;
 * 2. reload the user's balances (the message carries ids only, never amounts to act on) and record one notification.
 * The inbox row and the notification commit together or not at all, so a crash between them cannot lose the message or apply it twice.
 * Event types nobody consumes yet, and a message whose ids cannot be read, are acked: no retry could change either.
 */
@Injectable()
export class NotificationHandler implements JobHandler {
  readonly job = 'notify.events';
  private readonly logger = new Logger(NotificationHandler.name);

  constructor(
    private readonly runner: TransactionRunner,
    private readonly inbox: InboxService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsRepository,
  ) {}

  async handle(envelope: Envelope): Promise<void> {
    if (envelope.type !== BALANCE_CHANGED) return;
    const change = read(envelope.payload);
    if (!change) {
      this.logger.warn(
        `message ${envelope.messageId}: unreadable ${BALANCE_CHANGED} payload, dropped`,
      );
      return;
    }
    await this.runner.run(async (tx) => {
      const first = await this.inbox.markProcessed(
        tx,
        NOTIFICATION_CONSUMER,
        envelope.messageId,
      );
      if (!first) return;
      const balances = await this.ledger.getBalances(tx, change.userId);
      const now = balances.get(change.currency);
      if (!now) return;
      await this.notifications.insert(tx, {
        messageId: envelope.messageId,
        userId: change.userId,
        currency: change.currency,
        journalId: change.journalId,
        available: now.available,
        frozen: now.frozen,
        debt: now.debt,
      });
    });
  }
}

function read(payload: Readonly<Record<string, string>>): BalanceChange | null {
  const { userId, currency, journalId } = payload;
  if (!userId || !Object.hasOwn(CURRENCIES, currency)) return null;
  if (!journalId || !/^\d+$/.test(journalId)) return null;
  return {
    userId,
    currency: currency as CurrencyCode,
    journalId: BigInt(journalId),
  };
}
