import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { Money } from '../../common/money';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { TransactionRunner } from '../../database/transaction-runner';
import { newLedgerService } from '../ledger/testing';
import { HistoryItem, HistoryResponse, WalletResponse } from './wallet.mapper';

describeDb('GET /wallets/:userId and /ledger (real PostgreSQL)', () => {
  let ds: DataSource;
  let app: INestApplication<App>;
  let runner: TransactionRunner;
  const ledger = newLedgerService();

  beforeAll(async () => {
    ds = await connectTestDb();
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 5000,
      statementTimeoutMs: 10_000,
    });
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRole('api')],
    }).compile();
    app = ref.createNestApplication({ rawBody: true });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    if (ds?.isInitialized) await ds.destroy();
  });

  const newUser = () => `w_${randomUUID().slice(0, 12)}`;
  const get = (path: string) => request(app.getHttpServer()).get(path);

  /** Builders: money moved the legitimate way, through the ledger. */
  const credit = (userId: string, rial: bigint) =>
    runner.run((tx) =>
      ledger.creditUser(tx, {
        userId,
        amount: Money.rial(rial),
        source: 'OPS_ADJUSTMENTS',
        kind: 'ADJUSTMENT_CREDIT',
        refId: randomUUID(),
        description: `credit ${rial}`,
      }),
    );
  const freeze = (userId: string, rial: bigint) =>
    runner.run(async (tx) => {
      const ids = await ledger.ensureUserAccounts(tx, userId, 'IRR');
      return ledger.post(tx, {
        kind: 'WITHDRAWAL_FREEZE',
        refId: randomUUID(),
        currency: 'IRR',
        lines: [
          { accountId: ids.available, amount: Money.rial(-rial) },
          { accountId: ids.frozen, amount: Money.rial(rial) },
        ],
      });
    });
  const owe = (userId: string, rial: bigint) =>
    runner.run(async (tx) => {
      const ids = await ledger.ensureUserAccounts(tx, userId, 'IRR');
      const clearing = await ledger.systemAccountId(
        tx,
        'PAYOUT_CLEARING',
        'IRR',
      );
      return ledger.post(tx, {
        kind: 'WITHDRAWAL_LATE_SUCCESS',
        refId: randomUUID(),
        currency: 'IRR',
        lines: [
          { accountId: clearing, amount: Money.rial(rial) },
          { accountId: ids.debt, amount: Money.rial(-rial) },
        ],
      });
    });
  const accountRows = async (userId: string) => {
    const [{ n }] = await ds.query<{ n: string }[]>(
      'SELECT count(*)::text AS n FROM accounts WHERE user_id = $1',
      [userId],
    );
    return n;
  };

  describe('GET /wallets/:userId (W1)', () => {
    it('an unknown user gets zeros in IRT and USDT, and no row is created', async () => {
      const userId = newUser();
      const res = await get(`/wallets/${userId}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        userId,
        balances: [
          {
            currency: 'IRT',
            available: '0',
            frozen: '0',
            total: '0',
            debt: '0',
          },
          {
            currency: 'USDT',
            available: '0',
            frozen: '0',
            total: '0',
            debt: '0',
          },
        ],
      });
      expect(await accountRows(userId)).toBe('0');
    });

    it('shows available, frozen, total = available + frozen, in toman', async () => {
      const userId = newUser();
      await credit(userId, 100_000n);
      await freeze(userId, 30_000n);

      const body = (await get(`/wallets/${userId}`)).body as WalletResponse;
      expect(body.balances[0]).toEqual({
        currency: 'IRT',
        available: '7000',
        frozen: '3000',
        total: '10000',
        debt: '0',
      });
    });

    it('shows debt as the positive amount owed', async () => {
      const userId = newUser();
      await owe(userId, 25_000n);
      const body = (await get(`/wallets/${userId}`)).body as WalletResponse;
      expect(body.balances[0]).toMatchObject({ available: '0', debt: '2500' });
    });

    it.each(['bad%20id', 'x'.repeat(65), 'a.b'])(
      'refuses userId %j with 400 VALIDATION_ERROR',
      async (userId) => {
        const res = await get(`/wallets/${userId}`);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      },
    );
  });

  describe('GET /wallets/:userId/ledger (W2)', () => {
    const history = async (userId: string, query = '') => {
      const res = await get(`/wallets/${userId}/ledger${query}`);
      expect(res.status).toBe(200);
      return res.body as HistoryResponse;
    };

    it('lists postings newest first with journal, bucket, signed amount and balance after', async () => {
      const userId = newUser();
      const { journalId: creditId } = await credit(userId, 100_000n);
      const { journalId: freezeId } = await freeze(userId, 30_000n);

      const { items, nextCursor } = await history(userId);
      expect(nextCursor).toBeNull();
      expect(
        items.map((i) => [i.type, i.bucket, i.amount, i.balanceAfter]),
      ).toEqual([
        ['WITHDRAWAL_FREEZE', 'FROZEN', '3000', '3000'],
        ['WITHDRAWAL_FREEZE', 'AVAILABLE', '-3000', '7000'],
        ['ADJUSTMENT_CREDIT', 'AVAILABLE', '10000', '10000'],
      ]);
      const first: HistoryItem = items[2];
      expect(first).toEqual({
        id: expect.stringMatching(/^\d+$/) as string,
        journalId: creditId.toString(),
        type: 'ADJUSTMENT_CREDIT',
        bucket: 'AVAILABLE',
        currency: 'IRT',
        amount: '10000',
        balanceAfter: '10000',
        reference: { type: 'ADJUSTMENT', id: expect.any(String) as string },
        description: 'credit 100000',
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string,
      });
      expect(items[0].journalId).toBe(freezeId.toString());
    });

    it('pages with the cursor: every posting once, in order, then a null cursor', async () => {
      const userId = newUser();
      for (let i = 1; i <= 7; i++) await credit(userId, BigInt(i) * 10n);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await history(
          userId,
          `?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        );
        seen.push(...page.items.map((i) => i.amount));
        cursor = page.nextCursor;
        pages++;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toEqual(['7', '6', '5', '4', '3', '2', '1']);
    });

    it('defaults to 20 items per page', async () => {
      const userId = newUser();
      for (let i = 0; i < 21; i++) await credit(userId, 10n);
      const page = await history(userId);
      expect(page.items).toHaveLength(20);
      expect(page.nextCursor).not.toBeNull();
    });

    it('an unknown user has an empty history and gets no rows', async () => {
      const userId = newUser();
      expect(await history(userId)).toEqual({ items: [], nextCursor: null });
      expect(await accountRows(userId)).toBe('0');
    });

    it.each([
      ['limit=0', 'VALIDATION_ERROR'],
      ['limit=101', 'VALIDATION_ERROR'],
      ['limit=abc', 'VALIDATION_ERROR'],
      ['cursor=!!!', 'INVALID_CURSOR'],
      ['cursor=NDI%3D', 'INVALID_CURSOR'],
      ['page=2', 'VALIDATION_ERROR'],
    ])('refuses ?%s with 400 %s', async (query, code) => {
      const res = await get(`/wallets/${newUser()}/ledger?${query}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code });
    });
  });
});
