import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { Money } from '../../common/money';
import { loadConfig } from '../../config/app-config';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { TransactionRunner } from '../../database/transaction-runner';
import { newIdempotencyService } from '../idempotency/testing';
import { newLedgerService } from '../ledger/testing';
import { OutboxService } from '../messaging';
import { buildPolicies } from './domain/withdrawal-policy';
import { DailyLimitRepository } from './repositories/daily-limit.repository';
import { WithdrawalsRepository } from './repositories/withdrawals.repository';
import { WithdrawalService } from './withdrawal.service';

const IBAN = 'IR330566736841214070501510';
const TRC20 = 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y79bP';
const BAD_IBAN = 'IR330566736841214070501511'; // one digit off: fails mod-97

describeDb(
  'POST /withdrawals and GET /withdrawals/:id (real PostgreSQL)',
  () => {
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

    const newUser = () => `x3_${randomUUID().slice(0, 12)}`;
    const newKey = () => `x3-${randomUUID()}`;
    /** Credits a user the legitimate way, through the ledger. */
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
    const toman = (n: bigint) => Money.toman(n);
    const usdt = (n: bigint) => Money.microUsdt(n * 1_000_000n);

    const withdraw = (body: object, key: string | null = newKey()) => {
      const r = request(app.getHttpServer()).post('/withdrawals');
      if (key !== null) r.set('Idempotency-Key', key);
      return r.send(body);
    };
    const irt = (userId: string, amount: string, destination = IBAN) => ({
      userId,
      currency: 'IRT',
      amount,
      destination,
    });

    const balances = async (userId: string, currency = 'IRR') => {
      const rows = await ds.query<{ kind: string; b: string }[]>(
        `SELECT kind, balance_minor::text AS b FROM accounts
        WHERE user_id = $1 AND currency = $2`,
        [userId, currency],
      );
      return Object.fromEntries(rows.map((r) => [r.kind, r.b]));
    };
    const today = async () =>
      (
        await ds.query<{ d: string }[]>(
          `SELECT to_char(now() AT TIME ZONE 'Asia/Tehran', 'YYYY-MM-DD') AS d`,
        )
      )[0].d;
    const usage = async (userId: string) => {
      const rows = await ds.query<{ used: string }[]>(
        'SELECT used_rial::text AS used FROM withdrawal_daily_usage WHERE user_id = $1 AND day = $2',
        [userId, await today()],
      );
      return rows[0]?.used ?? null;
    };
    const count = async (sql: string, ...params: unknown[]) =>
      (await ds.query<{ n: string }[]>(sql, params))[0].n;
    const keyRow = async (key: string) =>
      (
        await ds.query<
          {
            status: string;
            response_status: number;
            resource_id: string | null;
          }[]
        >(
          'SELECT status, response_status, resource_id FROM idempotency_keys WHERE key = $1',
          [key],
        )
      )[0];

    describe('a successful request', () => {
      it('commits the withdrawal, FREEZE journal, daily usage, outbox job and stored response together', async () => {
        const userId = newUser();
        await fund(userId, toman(500_000n));
        const key = newKey();

        const res = await withdraw(
          irt(userId, '150000', 'ir33 0566 7368 4121 4070 5015 10'),
          key,
        );
        expect(res.status).toBe(201);
        const { withdrawalId } = res.body as { withdrawalId: string };
        expect(res.body).toEqual({ withdrawalId, status: 'PENDING' });

        const [w] = await ds.query<Record<string, unknown>[]>(
          `SELECT status, destination, amount_minor::text AS amount, fee_minor::text AS fee,
                to_char(limit_day, 'YYYY-MM-DD') AS day, limit_amount_rial::text AS limit,
                extract(epoch FROM next_check_at - now())::int AS check_in
           FROM withdrawals WHERE id = $1`,
          [withdrawalId],
        );
        expect(w).toMatchObject({
          status: 'PENDING',
          destination: IBAN, // normalised from spaced lowercase
          amount: '1500000',
          fee: '0',
          day: await today(),
          limit: '1500000',
        });
        expect(w.check_in).toBeGreaterThan(20);

        const postings = await ds.query<{ kind: string; amount: string }[]>(
          `SELECT p.account_kind AS kind, p.amount_minor::text AS amount
           FROM journals j JOIN postings p ON p.journal_id = j.id
          WHERE j.kind = 'WITHDRAWAL_FREEZE' AND j.ref_id = $1 ORDER BY p.id`,
          [withdrawalId],
        );
        expect(postings).toEqual([
          { kind: 'AVAILABLE', amount: '-1500000' },
          { kind: 'FROZEN', amount: '1500000' },
        ]);
        expect(await balances(userId)).toEqual({
          AVAILABLE: '3500000',
          FROZEN: '1500000',
          DEBT: '0',
        });
        expect(await usage(userId)).toBe('1500000');
        expect(
          await count(
            `SELECT count(*)::text AS n FROM outbox
            WHERE routing_key = 'job.withdrawal.submit' AND aggregate_id = $1
              AND payload = jsonb_build_object('withdrawalId', $1::text)`,
            withdrawalId,
          ),
        ).toBe('1');
        expect(await keyRow(key)).toEqual({
          status: 'COMPLETED',
          response_status: 201,
          resource_id: withdrawalId,
        });
      });

      it('a failure at the last write leaves nothing: no withdrawal, journal, usage, job or key', async () => {
        const userId = newUser();
        await fund(userId, toman(500_000n));
        const config = loadConfig();
        const failingOutbox = {
          add: () => Promise.reject(new Error('outbox unavailable')),
        } as unknown as OutboxService;
        const service = new WithdrawalService(
          runner,
          newIdempotencyService(),
          ledger,
          failingOutbox,
          new WithdrawalsRepository(),
          new DailyLimitRepository(),
          buildPolicies(config.limits),
          config,
        );
        const key = newKey();

        await expect(
          service.request(
            {
              userId,
              amount: toman(150_000n),
              destination: IBAN,
              body: { userId },
            },
            key,
          ),
        ).rejects.toThrow('outbox unavailable');

        expect(
          await count(
            'SELECT count(*)::text AS n FROM withdrawals WHERE user_id = $1',
            userId,
          ),
        ).toBe('0');
        expect(
          await count(
            `SELECT count(*)::text AS n FROM postings WHERE user_id = $1 AND account_kind = 'FROZEN'`,
            userId,
          ),
        ).toBe('0');
        expect(await balances(userId)).toEqual({
          AVAILABLE: '5000000',
          FROZEN: '0',
          DEBT: '0',
        });
        expect(await usage(userId)).toBeNull();
        expect(await keyRow(key)).toBeUndefined();
      });

      it('a replay returns the same response and creates nothing more', async () => {
        const userId = newUser();
        await fund(userId, toman(500_000n));
        const key = newKey();
        const first = await withdraw(irt(userId, '150000'), key);
        const again = await withdraw(irt(userId, '150000'), key);

        expect(again.status).toBe(201);
        expect(again.headers['idempotent-replayed']).toBe('true');
        expect(again.text).toBe(first.text);
        expect(
          await count(
            'SELECT count(*)::text AS n FROM withdrawals WHERE user_id = $1',
            userId,
          ),
        ).toBe('1');
        expect((await balances(userId)).FROZEN).toBe('1500000');
      });

      it('freezes amount + fee for USDT: withdrawing 10 needs 11 available', async () => {
        const userId = newUser();
        await fund(userId, usdt(10n));
        const body = {
          userId,
          currency: 'USDT',
          amount: '10',
          destination: TRC20,
        };

        const short = await withdraw(body);
        expect(short.status).toBe(422);
        expect(short.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

        await fund(userId, usdt(1n));
        const ok = await withdraw(body);
        expect(ok.status).toBe(201);
        expect(await balances(userId, 'USDT')).toEqual({
          AVAILABLE: '0',
          FROZEN: '11000000',
          DEBT: '0',
        });
      });

      it('10 concurrent withdrawals with funds for 3: exactly 3 succeed, nothing overdrawn', async () => {
        const userId = newUser();
        await fund(userId, toman(300_000n));
        const results = await Promise.all(
          Array.from({ length: 10 }, () => withdraw(irt(userId, '100000'))),
        );
        const codes = results.map((r) =>
          r.status === 201 ? 201 : (r.body as { code: string }).code,
        );
        expect(codes.filter((c) => c === 201)).toHaveLength(3);
        expect(codes.filter((c) => c === 'INSUFFICIENT_FUNDS')).toHaveLength(7);
        expect(await balances(userId)).toEqual({
          AVAILABLE: '0',
          FROZEN: '3000000',
          DEBT: '0',
        });
      });
    });

    describe('error precedence (design §4): the first rule broken decides', () => {
      const OVER_LIMIT = '200000001'; // one toman over the 200,000,000 toman day

      it('1. no Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED, before the body is looked at', async () => {
        const res = await withdraw({ amount: 1.5 }, null);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
      });

      it.each([
        ['a fractional toman amount', { amount: '1.5' }],
        ['a number for the amount', { amount: 150000 }],
        ['an unknown currency', { currency: 'EUR' }],
        ['a malformed userId', { userId: 'not valid!' }],
        ['no destination', { destination: undefined }],
      ])(
        '2. %s → 400 VALIDATION_ERROR, even with a bad destination too',
        async (_c, change) => {
          const res = await withdraw({
            ...irt(newUser(), '1', BAD_IBAN),
            ...change,
          });
          expect(res.status).toBe(400);
          expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
        },
      );

      it.each([
        ['a Sheba failing mod-97', irt('u', '1', BAD_IBAN)],
        [
          'USDT to an IBAN',
          { userId: 'u', currency: 'USDT', amount: '1', destination: IBAN },
        ],
        ['IRT to a TRC20 address', irt('u', '1', TRC20)],
      ])(
        '3. %s → 400 INVALID_DESTINATION, before the minimum and the funds',
        async (_c, body) => {
          const res = await withdraw({ ...body, userId: newUser() });
          expect(res.status).toBe(400);
          expect(res.body).toMatchObject({ code: 'INVALID_DESTINATION' });
        },
      );

      it('4. below the minimum with no funds → 422 BELOW_MINIMUM, not stored on the key', async () => {
        const key = newKey();
        const res = await withdraw(irt(newUser(), '99999'), key);
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'BELOW_MINIMUM' });
        expect(await keyRow(key)).toBeUndefined();
      });

      it('5. no funds while also over the daily limit → 422 INSUFFICIENT_FUNDS, stored and replayed', async () => {
        const userId = newUser();
        const key = newKey();
        const res = await withdraw(irt(userId, OVER_LIMIT), key);
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
        expect(await keyRow(key)).toMatchObject({
          status: 'COMPLETED',
          response_status: 422,
        });

        await fund(userId, toman(300_000_000n)); // funds arrive later: the stored answer stands
        const again = await withdraw(irt(userId, OVER_LIMIT), key);
        expect(again.status).toBe(422);
        expect(again.headers['idempotent-replayed']).toBe('true');
        expect(again.body).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      });

      it('6. funded but over the daily limit → 422 DAILY_LIMIT_EXCEEDED, stored, nothing frozen', async () => {
        const userId = newUser();
        await fund(userId, toman(300_000_000n));
        const key = newKey();
        const res = await withdraw(irt(userId, OVER_LIMIT), key);
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED' });
        expect(await keyRow(key)).toMatchObject({
          status: 'COMPLETED',
          response_status: 422,
        });
        expect((await balances(userId)).FROZEN).toBe('0');
        expect(
          await count(
            'SELECT count(*)::text AS n FROM withdrawals WHERE user_id = $1',
            userId,
          ),
        ).toBe('0');
      });

      it('the same key with another body → 422 IDEMPOTENCY_KEY_REUSED', async () => {
        const userId = newUser();
        await fund(userId, toman(500_000n));
        const key = newKey();
        await withdraw(irt(userId, '150000'), key);
        const res = await withdraw(irt(userId, '160000'), key);
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      });
    });

    describe('USDT counts toward the daily toman limit at the reference rate (B2)', () => {
      const { withdrawDailyLimitRial: cap, usdtReferenceRateRial: rate } =
        loadConfig().limits;
      /** Rial counted for a USDT amount: at the rate, rounded up. */
      const counted = (micro: bigint) => (micro * rate + 999_999n) / 1_000_000n;
      const microOf = (rial: bigint) => (rial * 1_000_000n) / rate;
      /** A micro-USDT amount as the API's decimal string. */
      const decimal = (micro: bigint) =>
        `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, '0')}`;
      const usdtBody = (userId: string, amount: string) => ({
        userId,
        currency: 'USDT',
        amount,
        destination: TRC20,
      });
      const row = async (id: string) =>
        (
          await ds.query<
            { rate: string | null; counted: string; day: string }[]
          >(
            `SELECT limit_rate_rial_per_usdt::text AS rate, limit_amount_rial::text AS counted,
                    to_char(limit_day, 'YYYY-MM-DD') AS day
               FROM withdrawals WHERE id = $1`,
            [id],
          )
        )[0];

      it('saves the rate on the row and counts the amount at that rate, without the fee', async () => {
        const userId = newUser();
        await fund(userId, usdt(30n));

        const res = await withdraw(usdtBody(userId, '12.345679'));
        expect(res.status).toBe(201);
        const { withdrawalId } = res.body as { withdrawalId: string };

        const expected = counted(12_345_679n);
        expect(await row(withdrawalId)).toEqual({
          rate: rate.toString(),
          counted: expected.toString(),
          day: await today(),
        });
        expect(await usage(userId)).toBe(expected.toString());
        expect((await balances(userId, 'USDT')).FROZEN).toBe('13345679');
      });

      it('an IRT withdrawal keeps no rate and counts at face value', async () => {
        const userId = newUser();
        await fund(userId, toman(500_000n));
        const res = await withdraw(irt(userId, '150000'));
        const { withdrawalId } = res.body as { withdrawalId: string };
        expect(await row(withdrawalId)).toMatchObject({
          rate: null,
          counted: '1500000',
        });
      });

      it('IRT and USDT share one cap: IRT first, USDT up to the cap, then both are refused', async () => {
        const userId = newUser();
        await fund(userId, toman(1_000_000_000n));
        await fund(userId, usdt(10_000n));
        const irtRial = 150_000_000n * 10n;
        expect((await withdraw(irt(userId, '150000000'))).status).toBe(201);

        const room = microOf(cap - irtRial);
        const fill = await withdraw(usdtBody(userId, decimal(room)));
        expect(fill.status).toBe(201);
        expect(BigInt((await usage(userId)) ?? '0')).toBe(
          irtRial + counted(room),
        );

        const usdtBefore = await balances(userId, 'USDT');
        const refusedUsdt = await withdraw(usdtBody(userId, '10'));
        expect(refusedUsdt.status).toBe(422);
        expect(refusedUsdt.body).toMatchObject({
          code: 'DAILY_LIMIT_EXCEEDED',
        });
        expect(await balances(userId, 'USDT')).toEqual(usdtBefore);
        const refusedIrt = await withdraw(irt(userId, '1000000'));
        expect(refusedIrt.status).toBe(422);
        expect(refusedIrt.body).toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED' });
      });

      it('USDT first, then IRT: the same cap in the other order, to the last toman', async () => {
        const userId = newUser();
        await fund(userId, toman(1_000_000_000n));
        await fund(userId, usdt(5_000n));
        const usdtMicro = microOf((cap * 3n) / 4n);
        expect(
          (await withdraw(usdtBody(userId, decimal(usdtMicro)))).status,
        ).toBe(201);

        const leftToman = (cap - counted(usdtMicro)) / 10n;
        const over = await withdraw(irt(userId, (leftToman + 1n).toString()));
        expect(over.status).toBe(422);
        expect(over.body).toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED' });
        expect((await withdraw(irt(userId, leftToman.toString()))).status).toBe(
          201,
        );
      });

      it('a USDT withdrawal worth more than the cap is refused whole: nothing reserved, nothing frozen', async () => {
        const userId = newUser();
        await fund(userId, usdt(5_000n));
        const over = microOf(cap) / 1_000_000n + 1n;
        const res = await withdraw(usdtBody(userId, over.toString()));
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED' });
        expect(BigInt((await usage(userId)) ?? '0')).toBe(0n);
        expect(await balances(userId, 'USDT')).toMatchObject({
          AVAILABLE: '5000000000',
          FROZEN: '0',
        });
      });

      it('the largest USDT amount the API accepts is refused cleanly, never a 500', async () => {
        const res = await withdraw(usdtBody(newUser(), '9223372036854.775807'));
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      });
    });

    describe('GET /withdrawals/:id', () => {
      it('returns the withdrawal in API units with the destination masked', async () => {
        const userId = newUser();
        await fund(userId, toman(500_000n));
        const { withdrawalId } = (await withdraw(irt(userId, '150000')))
          .body as {
          withdrawalId: string;
        };

        const res = await request(app.getHttpServer()).get(
          `/withdrawals/${withdrawalId}`,
        );
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          withdrawalId,
          status: 'PENDING',
          userId,
          currency: 'IRT',
          amount: '150000',
          fee: '0',
          destination: 'IR33******************1510',
          failureReason: null,
          returnedAt: null,
          returnReason: null,
          needsReview: false,
          createdAt: expect.any(String) as string,
          updatedAt: expect.any(String) as string,
        });
      });

      it.each([randomUUID(), 'not-a-uuid'])(
        'answers 404 NOT_FOUND for %s',
        async (id) => {
          const res = await request(app.getHttpServer()).get(
            `/withdrawals/${id}`,
          );
          expect(res.status).toBe(404);
          expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
        },
      );
    });

    it('keeps the invariants green: FROZEN equals what the open withdrawals hold', async () => {
      const userId = newUser();
      await fund(userId, usdt(30n));
      await withdraw({
        userId,
        currency: 'USDT',
        amount: '10',
        destination: TRC20,
      });
      await withdraw({
        userId,
        currency: 'USDT',
        amount: '12.5',
        destination: TRC20,
      });

      const res = await request(app.getHttpServer()).get(
        '/internal/invariants',
      );
      const mentions = (
        res.body as { checks: { violations: Record<string, string>[] }[] }
      ).checks.flatMap((c) =>
        c.violations.filter((v) => Object.values(v).includes(userId)),
      );
      expect(mentions).toEqual([]);
      expect((await balances(userId, 'USDT')).FROZEN).toBe('24500000'); // (10 + 1) + (12.5 + 1)
    });
  },
);
