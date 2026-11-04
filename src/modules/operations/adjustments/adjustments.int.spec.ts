import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { Money } from '../../../common/money';
import { connectTestDb, describeDb } from '../../../database/int-testing';
import { TransactionRunner } from '../../../database/transaction-runner';
import { newLedgerService } from '../../ledger/testing';

describeDb('POST /internal/adjustments (real PostgreSQL)', () => {
  let ds: DataSource;
  let app: INestApplication<App>;

  beforeAll(async () => {
    ds = await connectTestDb();
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

  const newUser = () => `o1_${randomUUID().slice(0, 12)}`;
  const newKey = () => `o1-${randomUUID()}`;
  const adjust = (key: string | null, body: object, operator?: string) => {
    const r = request(app.getHttpServer()).post('/internal/adjustments');
    if (key !== null) r.set('Idempotency-Key', key);
    if (operator !== undefined) r.set('X-Operator-Id', operator);
    return r.send(body);
  };
  const valid = (userId: string, amount = '5000') => ({
    userId,
    currency: 'IRT',
    amount,
    reason: 'goodwill credit for ticket 1234',
  });

  const balances = async (userId: string) => {
    const rows = await ds.query<{ kind: string; balance: string }[]>(
      `SELECT kind, balance_minor::text AS balance FROM accounts
        WHERE user_id = $1 AND currency = 'IRR' ORDER BY kind`,
      [userId],
    );
    return Object.fromEntries(rows.map((r) => [r.kind, r.balance]));
  };
  const countFor = async (
    table: 'adjustments' | 'postings',
    userId: string,
  ) => {
    const [{ n }] = await ds.query<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM ${table} WHERE user_id = $1`,
      [userId],
    );
    return n;
  };

  it('credits the user: 201, balance and ledger both show it, toman stored as rial', async () => {
    const userId = newUser();
    const res = await adjust(newKey(), valid(userId), 'ops-maryam');

    expect(res.status).toBe(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(res.body).toEqual({
      adjustmentId: expect.stringMatching(/^[0-9a-f-]{14}7/) as string,
      journalId: expect.stringMatching(/^\d+$/) as string,
      userId,
      currency: 'IRT',
      amount: '5000',
    });
    const { adjustmentId, journalId } = res.body as {
      adjustmentId: string;
      journalId: string;
    };

    expect(await balances(userId)).toEqual({
      AVAILABLE: '50000',
      DEBT: '0',
      FROZEN: '0',
    });
    const postings = await ds.query<{ kind: string; amount: string }[]>(
      `SELECT account_kind AS kind, amount_minor::text AS amount
         FROM postings WHERE journal_id = $1 ORDER BY id`,
      [journalId],
    );
    expect(postings).toEqual([
      { kind: 'OPS_ADJUSTMENTS', amount: '-50000' },
      { kind: 'AVAILABLE', amount: '50000' },
    ]);
    const [journal] = await ds.query<{ kind: string; ref_id: string }[]>(
      'SELECT kind, ref_id FROM journals WHERE id = $1',
      [journalId],
    );
    expect(journal).toEqual({
      kind: 'ADJUSTMENT_CREDIT',
      ref_id: adjustmentId,
    });
    const [row] = await ds.query<{ reason: string; actor: string }[]>(
      'SELECT reason, actor FROM adjustments WHERE id = $1',
      [adjustmentId],
    );
    expect(row).toEqual({
      reason: 'goodwill credit for ticket 1234',
      actor: 'ops-maryam',
    });
  });

  it('a replay with the same key adds nothing and returns the same response', async () => {
    const userId = newUser();
    const key = newKey();
    const first = await adjust(key, valid(userId));
    const again = await adjust(key, valid(userId));

    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.text).toBe(first.text);
    expect((await balances(userId)).AVAILABLE).toBe('50000');
    expect(await countFor('adjustments', userId)).toBe('1');
    expect(await countFor('postings', userId)).toBe('1');
  });

  it('10 concurrent requests with one key credit once', async () => {
    const userId = newUser();
    const key = newKey();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => adjust(key, valid(userId))),
    );

    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(new Set(results.map((r) => r.text)).size).toBe(1);
    expect((await balances(userId)).AVAILABLE).toBe('50000');
    expect(await countFor('adjustments', userId)).toBe('1');
  });

  it('the same key with another body returns 422 and adds nothing', async () => {
    const userId = newUser();
    const key = newKey();
    await adjust(key, valid(userId));
    const res = await adjust(key, valid(userId, '6000'));

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect((await balances(userId)).AVAILABLE).toBe('50000');
  });

  it('pays off DEBT first, then credits AVAILABLE with the rest', async () => {
    const userId = newUser();
    const ledger = newLedgerService();
    const runner = new TransactionRunner(ds, {
      lockTimeoutMs: 5000,
      statementTimeoutMs: 10_000,
    });
    await runner.run(async (tx) => {
      const ids = await ledger.ensureUserAccounts(tx, userId, 'IRR');
      const clearing = await ledger.systemAccountId(
        tx,
        'PAYOUT_CLEARING',
        'IRR',
      );
      await ledger.post(tx, {
        kind: 'WITHDRAWAL_LATE_SUCCESS',
        refId: randomUUID(),
        currency: 'IRR',
        lines: [
          { accountId: clearing, amount: Money.rial(30_000n) },
          { accountId: ids.debt, amount: Money.rial(-30_000n) },
        ],
      });
    });

    const res = await adjust(newKey(), valid(userId, '5000'));
    expect(res.status).toBe(201);
    expect(await balances(userId)).toEqual({
      AVAILABLE: '20000',
      DEBT: '0',
      FROZEN: '0',
    });
  });

  it.each([
    ['no reason', { reason: undefined }],
    ['a 2-character reason', { reason: 'ok' }],
    ['a 501-character reason', { reason: 'x'.repeat(501) }],
    ['a zero amount', { amount: '0' }],
    ['a fractional toman amount', { amount: '1.5' }],
    ['a number instead of a string', { amount: 5000 }],
    ['an unknown currency', { currency: 'EUR' }],
    ['a malformed userId', { userId: 'not valid!' }],
    ['an unknown field', { extra: 1 }],
  ])(
    'rejects %s with 400 VALIDATION_ERROR and books nothing',
    async (_c, change) => {
      const userId = newUser();
      const res = await adjust(newKey(), { ...valid(userId), ...change });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await balances(userId)).toEqual({});
    },
  );

  it('rejects an X-Operator-Id longer than 128 characters', async () => {
    const res = await adjust(newKey(), valid(newUser()), 'o'.repeat(129));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('requires the Idempotency-Key', async () => {
    const res = await adjust(null, valid(newUser()));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('keeps the invariants green for the users it credited', async () => {
    const userId = newUser();
    await adjust(newKey(), valid(userId));
    const res = await request(app.getHttpServer()).get('/internal/invariants');
    const mentions = (
      res.body as { checks: { violations: Record<string, string>[] }[] }
    ).checks.flatMap((c) =>
      c.violations.filter((v) => Object.values(v).includes(userId)),
    );
    expect(mentions).toEqual([]);
  });
});
