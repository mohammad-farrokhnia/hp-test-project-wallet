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
import { InvariantsService } from '../operations/invariants/invariants.service';

describeDb('POST /transfers (real PostgreSQL)', () => {
  let ds: DataSource;
  let app: INestApplication<App>;
  let runner: TransactionRunner;
  const ledger = newLedgerService();

  beforeAll(async () => {
    ds = await connectTestDb();
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 20_000,
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

  /** Every user these tests create, so the invariants can be checked for them alone: other suites run at the same time. */
  const created: string[] = [];
  const newUser = () => {
    const id = `b3_${randomUUID().slice(0, 12)}`;
    created.push(id);
    return id;
  };
  const newKey = () => `b3-${randomUUID()}`;
  const toman = (n: bigint) => Money.toman(n);
  const usdt = (n: bigint) => Money.microUsdt(n * 1_000_000n);
  const fund = (userId: string, amount: Money) =>
    runner.run((tx) =>
      ledger.creditUser(tx, {
        userId,
        amount,
        source: 'OPS_ADJUSTMENTS',
        kind: 'ADJUSTMENT_CREDIT',
        refId: randomUUID(),
      }),
    );
  /** Puts a user `owed` rial in debt, the way a claw-back does. */
  const makeDebt = (userId: string, owed: bigint) =>
    runner.run(async (tx) => {
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
          { accountId: clearing, amount: Money.rial(owed) },
          { accountId: ids.debt, amount: Money.rial(-owed) },
        ],
      });
    });

  const transfer = (body: object, key: string | null = newKey()) => {
    const r = request(app.getHttpServer()).post('/transfers');
    if (key !== null) r.set('Idempotency-Key', key);
    return r.send(body);
  };
  const tx = (
    fromUserId: string,
    toUserId: string,
    amount: string,
    currency = 'IRT',
  ) => ({ fromUserId, toUserId, currency, amount });

  const balances = async (userId: string, currency = 'IRR') => {
    const rows = await ds.query<{ kind: string; b: string }[]>(
      `SELECT kind, balance_minor::text AS b FROM accounts WHERE user_id = $1 AND currency = $2`,
      [userId, currency],
    );
    return Object.fromEntries(rows.map((r) => [r.kind, r.b]));
  };
  const count = async (sql: string, ...params: unknown[]) =>
    (await ds.query<{ n: string }[]>(sql, params))[0].n;
  const total = async (users: string[]) =>
    (
      await ds.query<{ s: string }[]>(
        `SELECT coalesce(sum(balance_minor), 0)::text AS s FROM accounts WHERE user_id = ANY($1) AND currency = 'IRR'`,
        [users],
      )
    )[0].s;
  const body = (res: request.Response) => res.body as Record<string, string>;

  describe('a successful transfer', () => {
    it('moves the money in one TRANSFER journal and records the transfer, the key and the response together', async () => {
      const a = newUser();
      const b = newUser();
      await fund(a, toman(1_000n));
      const key = newKey();

      const res = await transfer(tx(a, b, '300'), key);

      expect(res.status).toBe(201);
      const { transferId } = body(res);
      expect(res.body).toEqual({ transferId });
      expect(await balances(a)).toMatchObject({ AVAILABLE: '7000' });
      expect(await balances(b)).toMatchObject({
        AVAILABLE: '3000',
        FROZEN: '0',
        DEBT: '0',
      });
      const [t] = await ds.query<Record<string, string>[]>(
        `SELECT from_user_id, to_user_id, currency, amount_minor::text AS amount, journal_id::text AS journal
           FROM transfers WHERE id = $1`,
        [transferId],
      );
      expect(t).toMatchObject({
        from_user_id: a,
        to_user_id: b,
        currency: 'IRR',
        amount: '3000',
      });
      const lines = await ds.query<{ user_id: string; amount: string }[]>(
        `SELECT p.user_id, p.amount_minor::text AS amount
           FROM postings p JOIN journals j ON j.id = p.journal_id
          WHERE j.id = $1 AND j.kind = 'TRANSFER' AND j.ref_id = $2
          ORDER BY p.amount_minor`,
        [t.journal, transferId],
      );
      expect(lines).toEqual([
        { user_id: a, amount: '-3000' },
        { user_id: b, amount: '3000' },
      ]);
      expect(
        await count(
          `SELECT count(*)::text AS n FROM idempotency_keys WHERE key = $1 AND status = 'COMPLETED' AND resource_id = $2`,
          key,
          transferId,
        ),
      ).toBe('1');
    });

    it('creates the receiver on first use, and can send the whole balance', async () => {
      const a = newUser();
      const b = newUser();
      await fund(a, toman(500n));
      expect((await transfer(tx(a, b, '500'))).status).toBe(201);
      expect(await balances(a)).toMatchObject({ AVAILABLE: '0' });
      expect(await balances(b)).toMatchObject({ AVAILABLE: '5000' });
    });

    it('moves USDT too, with no fee', async () => {
      const a = newUser();
      const b = newUser();
      await fund(a, usdt(10n));
      expect((await transfer(tx(a, b, '2.5', 'USDT'))).status).toBe(201);
      expect(await balances(a, 'USDT')).toMatchObject({
        AVAILABLE: '7500000',
      });
      expect(await balances(b, 'USDT')).toMatchObject({
        AVAILABLE: '2500000',
      });
    });

    it('pays off the receiver’s debt first, and only the rest is available', async () => {
      const a = newUser();
      const b = newUser();
      await fund(a, toman(1_000n));
      await makeDebt(b, 3_000n);
      expect(await balances(b)).toMatchObject({ DEBT: '-3000' });

      expect((await transfer(tx(a, b, '1000'))).status).toBe(201);

      expect(await balances(b)).toMatchObject({
        DEBT: '0',
        AVAILABLE: '7000',
      });
    });
  });

  describe('refusals', () => {
    it('a transfer to oneself is 422 SAME_USER, and nothing is created or stored', async () => {
      const a = newUser();
      await fund(a, toman(100n));
      const key = newKey();
      const res = await transfer(tx(a, a, '10'), key);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'SAME_USER' });
      expect(await balances(a)).toMatchObject({ AVAILABLE: '1000' });
      expect(
        await count(
          'SELECT count(*)::text AS n FROM transfers WHERE from_user_id = $1',
          a,
        ),
      ).toBe('0');
      expect(
        await count(
          'SELECT count(*)::text AS n FROM idempotency_keys WHERE key = $1',
          key,
        ),
      ).toBe('0');
    });

    it('more than the sender holds is a stored 422 INSUFFICIENT_FUNDS: nothing moves, and a repeat gets the same answer', async () => {
      const a = newUser();
      const b = newUser();
      await fund(a, toman(100n));
      const key = newKey();
      const first = await transfer(tx(a, b, '101'), key);
      expect(first.status).toBe(422);
      expect(first.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      await fund(a, toman(1_000n));
      const again = await transfer(tx(a, b, '101'), key);
      expect(again.status).toBe(422);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(await balances(a)).toMatchObject({ AVAILABLE: '11000' });
      expect(
        await count(
          'SELECT count(*)::text AS n FROM transfers WHERE from_user_id = $1',
          a,
        ),
      ).toBe('0');
    });

    it('a sender who owes money and holds none cannot send', async () => {
      const a = newUser();
      const b = newUser();
      await makeDebt(a, 10n);
      const res = await transfer(tx(a, b, '1'));
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    });

    it.each([
      ['zero', tx('a1', 'b1', '0')],
      ['negative', tx('a1', 'b1', '-5')],
      ['not a number', tx('a1', 'b1', 'abc')],
      ['a USDT amount with 7 decimals', tx('a1', 'b1', '1.1234567', 'USDT')],
      ['a bad sender id', tx('a b', 'b1', '5')],
      ['a bad receiver id', tx('a1', '', '5')],
      ['an unknown currency', tx('a1', 'b1', '5', 'EUR')],
      [
        'a missing field',
        { fromUserId: 'a1', toUserId: 'b1', currency: 'IRT' },
      ],
      ['an extra field', { ...tx('a1', 'b1', '5'), fee: '1' }],
    ])('%s → 400, nothing stored', async (_c, bad) => {
      const key = newKey();
      const res = await transfer(bad, key);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(
        await count(
          'SELECT count(*)::text AS n FROM idempotency_keys WHERE key = $1',
          key,
        ),
      ).toBe('0');
    });

    it('needs an Idempotency-Key', async () => {
      const res = await transfer(tx('a1', 'b1', '5'), null);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    });
  });

  describe('idempotency', () => {
    it('the same key and body replays the first answer: one transfer, one journal', async () => {
      const a = newUser();
      const b = newUser();
      await fund(a, toman(1_000n));
      const key = newKey();
      const first = await transfer(tx(a, b, '100'), key);
      const again = await transfer(tx(a, b, '100'), key);
      expect(again.status).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(body(again).transferId).toBe(body(first).transferId);
      expect(await balances(a)).toMatchObject({ AVAILABLE: '9000' });
      expect(
        await count(
          'SELECT count(*)::text AS n FROM transfers WHERE from_user_id = $1',
          a,
        ),
      ).toBe('1');
    });

    it('the same key with another body is 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const a = newUser();
      const b = newUser();
      await fund(a, toman(1_000n));
      const key = newKey();
      await transfer(tx(a, b, '100'), key);
      const res = await transfer(tx(a, b, '200'), key);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      expect(await balances(a)).toMatchObject({ AVAILABLE: '9000' });
    });

    it('20 simultaneous requests with one key make exactly one transfer', async () => {
      const a = newUser();
      const b = newUser();
      await fund(a, toman(1_000n));
      const key = newKey();
      const rs = await Promise.all(
        Array.from({ length: 20 }, () => transfer(tx(a, b, '100'), key)),
      );
      expect(rs.every((r) => r.status === 201)).toBe(true);
      expect(new Set(rs.map((r) => body(r).transferId)).size).toBe(1);
      expect(await balances(a)).toMatchObject({ AVAILABLE: '9000' });
    });
  });

  describe('concurrency (ADR-1): the accounts are locked in one global id order', () => {
    const statuses = (rs: request.Response[]) =>
      rs.map((r) => r.status).sort((x, y) => x - y);

    it('50 transfers A to B and 50 B to A at once: none fails, none deadlocks, the money is conserved', async () => {
      const a = newUser();
      const b = newUser();
      await fund(a, toman(1_000n));
      await fund(b, toman(1_000n));

      const rs = await Promise.all([
        ...Array.from({ length: 50 }, () => transfer(tx(a, b, '1'))),
        ...Array.from({ length: 50 }, () => transfer(tx(b, a, '1'))),
      ]);

      expect(statuses(rs).every((s) => s === 201)).toBe(true);
      expect(await total([a, b])).toBe('20000');
      expect(await balances(a)).toMatchObject({ AVAILABLE: '10000' });
      expect(await balances(b)).toMatchObject({ AVAILABLE: '10000' });
      expect(
        await count(
          `SELECT count(*)::text AS n FROM transfers WHERE from_user_id IN ($1, $2)`,
          a,
          b,
        ),
      ).toBe('100');
    });

    it('uneven opposite flows: the final balances are exactly the net', async () => {
      const a = newUser();
      const b = newUser();
      await fund(a, toman(1_000n));
      await fund(b, toman(1_000n));
      const rs = await Promise.all([
        ...Array.from({ length: 40 }, () => transfer(tx(a, b, '3'))),
        ...Array.from({ length: 25 }, () => transfer(tx(b, a, '2'))),
      ]);
      expect(statuses(rs).every((s) => s === 201)).toBe(true);
      const net = 40n * 30n - 25n * 20n;
      expect(await balances(a)).toMatchObject({
        AVAILABLE: (10_000n - net).toString(),
      });
      expect(await balances(b)).toMatchObject({
        AVAILABLE: (10_000n + net).toString(),
      });
    });

    it('a ring of three, every direction at once: no deadlock, conserved', async () => {
      const [a, b, c] = [newUser(), newUser(), newUser()];
      for (const u of [a, b, c]) await fund(u, toman(1_000n));
      const rs = await Promise.all([
        ...Array.from({ length: 30 }, () => transfer(tx(a, b, '1'))),
        ...Array.from({ length: 30 }, () => transfer(tx(b, c, '1'))),
        ...Array.from({ length: 30 }, () => transfer(tx(c, a, '1'))),
        ...Array.from({ length: 30 }, () => transfer(tx(b, a, '1'))),
        ...Array.from({ length: 30 }, () => transfer(tx(c, b, '1'))),
        ...Array.from({ length: 30 }, () => transfer(tx(a, c, '1'))),
      ]);
      expect(statuses(rs).every((s) => s === 201)).toBe(true);
      expect(await total([a, b, c])).toBe('30000');
    });

    it('opposite transfers between users who do not exist yet: first use races, one account set each, no deadlock', async () => {
      const a = newUser();
      const b = newUser();
      const sender = newUser();
      await fund(sender, toman(10_000n));
      const rs = await Promise.all([
        ...Array.from({ length: 20 }, () => transfer(tx(sender, a, '5'))),
        ...Array.from({ length: 20 }, () => transfer(tx(sender, b, '5'))),
        ...Array.from({ length: 20 }, () => transfer(tx(a, b, '1'))),
        ...Array.from({ length: 20 }, () => transfer(tx(b, a, '1'))),
      ]);
      const ok = rs.filter((r) => r.status === 201).length;
      const refused = rs.filter(
        (r) =>
          r.status === 422 &&
          (r.body as { code: string }).code === 'INSUFFICIENT_FUNDS',
      ).length;
      expect(ok + refused).toBe(80);
      expect(rs.some((r) => r.status >= 500 || r.status === 409)).toBe(false);
      for (const u of [a, b]) {
        expect(
          await count(
            `SELECT count(*)::text AS n FROM accounts WHERE user_id = $1 AND currency = 'IRR'`,
            u,
          ),
        ).toBe('3');
      }
      expect(await total([sender, a, b])).toBe('100000');
    });

    it('10 transfers of 100 from a balance of 350: exactly 3 succeed, nothing overdrawn', async () => {
      const a = newUser();
      const b = newUser();
      await fund(a, toman(350n));
      const rs = await Promise.all(
        Array.from({ length: 10 }, () => transfer(tx(a, b, '100'))),
      );
      expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
      expect(rs.filter((r) => r.status === 422)).toHaveLength(7);
      expect(await balances(a)).toMatchObject({ AVAILABLE: '500' });
      expect(await balances(b)).toMatchObject({ AVAILABLE: '3000' });
    });

    it('transfers and withdrawals on one balance at once never overdraw it', async () => {
      const a = newUser();
      const b = newUser();
      await fund(a, toman(1_000_000n));
      const rs = await Promise.all([
        ...Array.from({ length: 10 }, () => transfer(tx(a, b, '150000'))),
        ...Array.from({ length: 10 }, () =>
          request(app.getHttpServer())
            .post('/withdrawals')
            .set('Idempotency-Key', newKey())
            .send({
              userId: a,
              currency: 'IRT',
              amount: '150000',
              destination: 'IR330566736841214070501510',
            }),
        ),
      ]);
      expect(rs.some((r) => r.status >= 500)).toBe(false);
      const ok = rs.filter((r) => r.status === 201).length;
      expect(ok).toBe(6);
      const bal = await balances(a);
      expect(BigInt(bal.AVAILABLE)).toBeGreaterThanOrEqual(0n);
      expect(
        BigInt(bal.AVAILABLE) +
          BigInt(bal.FROZEN) +
          BigInt((await balances(b)).AVAILABLE),
      ).toBe(10_000_000n);
    });
  });

  it('the ledger invariants hold for every account these tests touched', async () => {
    const report = await app.get(InvariantsService).check();
    const mine = report.checks.flatMap((c) =>
      c.violations.filter((v) =>
        Object.values(v).some((x) => created.includes(String(x))),
      ),
    );
    expect(mine).toEqual([]);
    expect(created.length).toBeGreaterThan(20);
  });
});
