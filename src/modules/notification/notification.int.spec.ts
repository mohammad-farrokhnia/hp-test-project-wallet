import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Money } from '../../common/money';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { TransactionRunner, Tx } from '../../database/transaction-runner';
import { newLedgerService } from '../ledger/testing';
import { Envelope, InboxService } from '../messaging';
import { NotificationHandler } from './notification.handler';
import {
  NewNotification,
  NotificationsRepository,
} from './notifications.repository';

describeDb('inbox de-duplication and the notification consumer (B4)', () => {
  let ds: DataSource;
  let runner: TransactionRunner;
  const ledger = newLedgerService();
  const inbox = new InboxService();
  const notifications = new NotificationsRepository();

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    ds = await connectTestDb();
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 20_000,
    });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    jest.restoreAllMocks();
  });

  const newUser = () => `b4n_${randomUUID().slice(0, 12)}`;
  const handler = (
    repo: Pick<NotificationsRepository, 'insert'> = notifications,
  ) =>
    new NotificationHandler(
      runner,
      inbox,
      ledger,
      repo as NotificationsRepository,
    );
  const credit = (userId: string, amount: Money) =>
    runner.run((tx) =>
      ledger.creditUser(tx, {
        userId,
        amount,
        source: 'OPS_ADJUSTMENTS',
        kind: 'ADJUSTMENT_CREDIT',
        refId: randomUUID(),
      }),
    );
  const message = (
    userId: string,
    journalId: bigint,
    over: Partial<Envelope> = {},
  ): Envelope => ({
    messageId: randomUUID(),
    type: 'wallet.balance.changed',
    aggregateType: 'WALLET',
    aggregateId: userId,
    occurredAt: new Date().toISOString(),
    payload: {
      userId,
      currency: 'IRR',
      journalId: journalId.toString(),
      kind: 'ADJUSTMENT_CREDIT',
    },
    ...over,
  });
  const forUser = (userId: string) =>
    runner.run((tx) => notifications.listForUser(tx, userId), {
      readOnly: true,
    });
  const inboxRows = async (messageId: string) =>
    (
      await ds.query<{ n: string }[]>(
        `SELECT count(*)::text AS n FROM inbox WHERE message_id = $1`,
        [messageId],
      )
    )[0].n;

  describe('InboxService', () => {
    it('lets a message through once per consumer', async () => {
      const id = randomUUID();
      const first = await runner.run((tx) => inbox.markProcessed(tx, 'c1', id));
      const again = await runner.run((tx) => inbox.markProcessed(tx, 'c1', id));
      const other = await runner.run((tx) => inbox.markProcessed(tx, 'c2', id));
      expect([first, again, other]).toEqual([true, false, true]);
    });

    it('a transaction that rolls back leaves no record, so the retry is not mistaken for a duplicate', async () => {
      const id = randomUUID();
      await expect(
        runner.run(async (tx) => {
          expect(await inbox.markProcessed(tx, 'c1', id)).toBe(true);
          throw new Error('effect failed');
        }),
      ).rejects.toThrow('effect failed');
      expect(await inboxRows(id)).toBe('0');
      expect(await runner.run((tx) => inbox.markProcessed(tx, 'c1', id))).toBe(
        true,
      );
    });

    it('20 simultaneous deliveries of one message: exactly one gets through', async () => {
      const id = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          runner.run((tx) => inbox.markProcessed(tx, 'c1', id)),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await inboxRows(id)).toBe('1');
    });
  });

  describe('NotificationHandler', () => {
    it('records one notification with the balances as they are now, not as the message says', async () => {
      const userId = newUser();
      const { journalId } = await credit(userId, Money.toman(100n));
      await credit(userId, Money.toman(50n));

      await handler().handle(message(userId, journalId));

      const [n] = await forUser(userId);
      expect(n).toMatchObject({
        userId,
        kind: 'BALANCE_CHANGED',
        currency: 'IRR',
        journalId,
      });
      expect(n.available.minor).toBe(1500n);
      expect(n.frozen.minor).toBe(0n);
      expect(n.debt.minor).toBe(0n);
    });

    it('a duplicate delivery is applied once', async () => {
      const userId = newUser();
      const { journalId } = await credit(userId, Money.toman(100n));
      const m = message(userId, journalId);

      await handler().handle(m);
      await handler().handle(m);
      await handler().handle(m);

      expect(await forUser(userId)).toHaveLength(1);
      expect(await inboxRows(m.messageId)).toBe('1');
    });

    it('twenty simultaneous deliveries of one message are applied once', async () => {
      const userId = newUser();
      const { journalId } = await credit(userId, Money.toman(100n));
      const m = message(userId, journalId);

      await Promise.all(Array.from({ length: 20 }, () => handler().handle(m)));

      expect(await forUser(userId)).toHaveLength(1);
    });

    it('different messages are different notifications, in order', async () => {
      const userId = newUser();
      const one = await credit(userId, Money.toman(10n));
      const two = await credit(userId, Money.toman(20n));
      await handler().handle(message(userId, one.journalId));
      await handler().handle(message(userId, two.journalId));
      const rows = await forUser(userId);
      expect(rows.map((r) => r.journalId)).toEqual([
        one.journalId,
        two.journalId,
      ]);
    });

    it('a failure after the inbox insert rolls both back, and the redelivery then succeeds', async () => {
      const userId = newUser();
      const { journalId } = await credit(userId, Money.toman(100n));
      const m = message(userId, journalId);
      let calls = 0;
      const flaky: Pick<NotificationsRepository, 'insert'> = {
        insert: (tx: Tx, n: NewNotification) => {
          if (++calls === 1) return Promise.reject(new Error('disk full'));
          return notifications.insert(tx, n);
        },
      };

      await expect(handler(flaky).handle(m)).rejects.toThrow('disk full');
      expect(await inboxRows(m.messageId)).toBe('0');
      expect(await forUser(userId)).toHaveLength(0);

      await handler(flaky).handle(m);
      expect(await forUser(userId)).toHaveLength(1);
      expect(await inboxRows(m.messageId)).toBe('1');
    });

    it.each([
      ['an event type nobody consumes yet', { type: 'deposit.status.changed' }],
      [
        'a payload without a user',
        { payload: { currency: 'IRR', journalId: '1' } },
      ],
      [
        'an unknown currency',
        { payload: { userId: 'u', currency: 'EUR', journalId: '1' } },
      ],
      [
        'a currency named like an object property',
        { payload: { userId: 'u', currency: 'toString', journalId: '1' } },
      ],
      [
        'a journal id that is not a number',
        { payload: { userId: 'u', currency: 'IRR', journalId: 'x1' } },
      ],
    ])(
      '%s is acked and ignored: no error, no notification',
      async (_c, over) => {
        const userId = newUser();
        const m = message(userId, 1n, over);
        await expect(handler().handle(m)).resolves.toBeUndefined();
        expect(await forUser(userId)).toHaveLength(0);
      },
    );
  });
});
