import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Money } from '../../common/money';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { TransactionRunner } from '../../database/transaction-runner';
import { newLedgerService } from './testing';

interface EventRow {
  exchange: string;
  routing_key: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, string>;
  published_at: Date | null;
}

describeDb(
  'balance events: an outbox event on every balance change (B4)',
  () => {
    let ds: DataSource;
    let runner: TransactionRunner;
    const ledger = newLedgerService();

    beforeAll(async () => {
      ds = await connectTestDb();
      runner = new TransactionRunner(ds, {
        lockTimeoutMs: 10_000,
        statementTimeoutMs: 20_000,
      });
    });

    afterAll(async () => {
      if (ds?.isInitialized) await ds.destroy();
    });

    const newUser = () => `b4_${randomUUID().slice(0, 12)}`;
    const events = (userId: string) =>
      ds.query<EventRow[]>(
        `SELECT exchange, routing_key, aggregate_type, aggregate_id, payload, published_at
         FROM outbox WHERE aggregate_type = 'WALLET' AND aggregate_id = $1 ORDER BY id`,
        [userId],
      );
    const credit = (userId: string, amount: Money, refId = randomUUID()) =>
      runner.run((tx) =>
        ledger.creditUser(tx, {
          userId,
          amount,
          source: 'OPS_ADJUSTMENTS',
          kind: 'ADJUSTMENT_CREDIT',
          refId,
        }),
      );

    it('a credit writes one event for the user, with ids only, unsent', async () => {
      const userId = newUser();
      const { journalId } = await credit(userId, Money.toman(100n));

      const rows = await events(userId);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        exchange: 'wallet.events',
        routing_key: 'wallet.balance.changed',
        aggregate_type: 'WALLET',
        aggregate_id: userId,
        payload: {
          userId,
          currency: 'IRR',
          journalId: journalId.toString(),
          kind: 'ADJUSTMENT_CREDIT',
        },
        published_at: null,
      });
    });

    it('carries no amounts or balances: the consumer reloads them', async () => {
      const userId = newUser();
      await credit(userId, Money.toman(123_456n));
      const [e] = await events(userId);
      expect(Object.keys(e.payload).sort()).toEqual([
        'currency',
        'journalId',
        'kind',
        'userId',
      ]);
      expect(JSON.stringify(e.payload)).not.toContain('1234560');
    });

    it('a journal between two users writes one event for each, and none for a system account', async () => {
      const a = newUser();
      const b = newUser();
      await credit(a, Money.toman(100n));
      const before = await events(b);

      const { journalId } = await runner.run(async (tx) => {
        const users = await ledger.lockUsersAccounts(tx, [a, b], 'IRR');
        const from = users.get(a)!;
        const to = users.get(b)!;
        return ledger.post(tx, {
          kind: 'TRANSFER',
          refId: randomUUID(),
          currency: 'IRR',
          lines: [
            { accountId: from.ids.available, amount: Money.rial(-400n) },
            { accountId: to.ids.available, amount: Money.rial(400n) },
          ],
        });
      });

      expect(before).toHaveLength(0);
      const forA = await events(a);
      const forB = await events(b);
      expect(forA).toHaveLength(2);
      expect(forB).toHaveLength(1);
      expect(forA[1].payload).toMatchObject({
        journalId: journalId.toString(),
        kind: 'TRANSFER',
      });
      expect(forB[0].payload).toMatchObject({
        journalId: journalId.toString(),
        kind: 'TRANSFER',
      });
    });

    it('a journal that touches only system accounts writes no event', async () => {
      const { journalId } = await runner.run(async (tx) => {
        const psp = await ledger.systemAccountId(tx, 'PSP_CLEARING', 'IRR');
        const ops = await ledger.systemAccountId(tx, 'OPS_ADJUSTMENTS', 'IRR');
        return ledger.post(tx, {
          kind: 'ADJUSTMENT_CREDIT',
          refId: randomUUID(),
          currency: 'IRR',
          lines: [
            { accountId: psp, amount: Money.rial(-5n) },
            { accountId: ops, amount: Money.rial(5n) },
          ],
        });
      });
      const [{ n }] = await ds.query<{ n: string }[]>(
        `SELECT count(*)::text AS n FROM outbox
        WHERE exchange = 'wallet.events' AND payload->>'journalId' = $1`,
        [journalId.toString()],
      );
      expect(n).toBe('0');
    });

    it('one user touched by several postings of one journal still gets one event', async () => {
      const a = newUser();
      const b = newUser();
      await credit(a, Money.toman(100n));
      await runner.run(async (tx) => {
        const clearing = await ledger.systemAccountId(
          tx,
          'PAYOUT_CLEARING',
          'IRR',
        );
        const ids = await ledger.ensureUserAccounts(tx, b, 'IRR');
        await ledger.post(tx, {
          kind: 'WITHDRAWAL_LATE_SUCCESS',
          refId: randomUUID(),
          currency: 'IRR',
          lines: [
            { accountId: clearing, amount: Money.rial(70n) },
            { accountId: ids.debt, amount: Money.rial(-70n) },
          ],
        });
      });
      const before = (await events(b)).length;
      await runner.run((tx) =>
        ledger.creditUser(tx, {
          userId: b,
          amount: Money.rial(100n),
          source: 'OPS_ADJUSTMENTS',
          kind: 'ADJUSTMENT_CREDIT',
          refId: randomUUID(),
        }),
      );
      expect(await events(b)).toHaveLength(before + 1);
    });

    it('booking the same journal twice writes the event once', async () => {
      const userId = newUser();
      const refId = randomUUID();
      const first = await credit(userId, Money.toman(10n), refId);
      const second = await credit(userId, Money.toman(10n), refId);
      expect(second.alreadyBooked).toBe(true);
      expect(second.journalId).toBe(first.journalId);
      expect(await events(userId)).toHaveLength(1);
    });

    it('a rolled-back transaction leaves no event, exactly as it leaves no journal', async () => {
      const userId = newUser();
      await expect(
        runner.run(async (tx) => {
          await ledger.creditUser(tx, {
            userId,
            amount: Money.toman(10n),
            source: 'OPS_ADJUSTMENTS',
            kind: 'ADJUSTMENT_CREDIT',
            refId: randomUUID(),
          });
          throw new Error('crash after booking, before commit');
        }),
      ).rejects.toThrow('crash after booking');
      expect(await events(userId)).toHaveLength(0);
    });

    it('a balance change of a flow other than transfers is announced too: freezing money for a withdrawal', async () => {
      const userId = newUser();
      await credit(userId, Money.toman(100n));
      const before = (await events(userId)).length;
      await runner.run(async (tx) => {
        const ids = await ledger.ensureUserAccounts(tx, userId, 'IRR');
        await ledger.post(tx, {
          kind: 'WITHDRAWAL_FREEZE',
          refId: randomUUID(),
          currency: 'IRR',
          lines: [
            { accountId: ids.available, amount: Money.rial(-300n) },
            { accountId: ids.frozen, amount: Money.rial(300n) },
          ],
        });
      });
      const after = await events(userId);
      expect(after).toHaveLength(before + 1);
      expect(after[after.length - 1].payload.kind).toBe('WITHDRAWAL_FREEZE');
    });
  },
);
