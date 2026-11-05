import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { Money } from '../../common/money';
import { AppConfig, loadConfig } from '../../config/app-config';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { TransactionRunner } from '../../database/transaction-runner';
import { newLedgerService } from '../ledger/testing';

const IBAN = 'IR330566736841214070501510';
const REQUESTS = 100;

/**
 * 100 concurrent withdrawals across TWO app instances (separate Nest apps and connection
 * pools, sharing only the database, as two api containers do). Exact counts, exact codes,
 * invariants green.
 */
describeDb(
  'withdrawal concurrency across 2 app instances (real PostgreSQL)',
  () => {
    let ds: DataSource;
    let runner: TransactionRunner;
    const apps: INestApplication<App>[] = [];
    const ledger = newLedgerService();

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      ds = await connectTestDb();
      runner = new TransactionRunner(ds, {
        lockTimeoutMs: 10_000,
        statementTimeoutMs: 20_000,
      });
      const config = loadConfig({
        ...process.env,
        DB_LOCK_TIMEOUT_MS: '30000',
        DB_STATEMENT_TIMEOUT_MS: '60000',
      });
      for (let i = 0; i < 2; i++) {
        const ref = await Test.createTestingModule({
          imports: [AppModule.forRole('api')],
        })
          .overrideProvider(AppConfig)
          .useValue(config)
          .compile();
        const app = ref.createNestApplication<INestApplication<App>>({
          rawBody: true,
        });
        await app.listen(0, '127.0.0.1');
        apps.push(app);
      }
    }, 60_000);

    afterAll(async () => {
      await Promise.all(apps.map((a) => a.close()));
      if (ds?.isInitialized) await ds.destroy();
      jest.restoreAllMocks();
    });

    const newUser = () => `x4_${randomUUID().slice(0, 12)}`;
    const fund = (userId: string, toman: bigint) =>
      runner.run((tx) =>
        ledger.creditUser(tx, {
          userId,
          amount: Money.toman(toman),
          source: 'OPS_ADJUSTMENTS',
          kind: 'ADJUSTMENT_CREDIT',
          refId: randomUUID(),
        }),
      );
    /** Request i goes to instance i % 2. */
    const withdraw = (i: number, body: object, key = `x4-${randomUUID()}`) =>
      request(apps[i % 2].getHttpServer())
        .post('/withdrawals')
        .set('Idempotency-Key', key)
        .send(body);
    const irt = (userId: string, toman: string) => ({
      userId,
      currency: 'IRT',
      amount: toman,
      destination: IBAN,
    });
    const outcome = (r: request.Response) =>
      r.status === 201
        ? '201'
        : `${r.status} ${(r.body as { code: string }).code}`;
    const tally = (codes: string[]) =>
      codes.reduce<Record<string, number>>(
        (m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }),
        {},
      );

    const facts = async (userId: string) => {
      const [row] = await ds.query<
        {
          available: string;
          frozen: string;
          withdrawals: string;
          usage: string | null;
        }[]
      >(
        `SELECT
         (SELECT balance_minor::text FROM accounts WHERE user_id = $1 AND kind = 'AVAILABLE' AND currency = 'IRR') AS available,
         (SELECT balance_minor::text FROM accounts WHERE user_id = $1 AND kind = 'FROZEN' AND currency = 'IRR') AS frozen,
         (SELECT count(*)::text FROM withdrawals WHERE user_id = $1) AS withdrawals,
         (SELECT used_rial::text FROM withdrawal_daily_usage WHERE user_id = $1
           AND day = (now() AT TIME ZONE 'Asia/Tehran')::date) AS usage`,
        [userId],
      );
      return row;
    };
    const invariantViolations = async (userId: string) => {
      const res = await request(apps[0].getHttpServer()).get(
        '/internal/invariants',
      );
      return (
        res.body as { checks: { violations: Record<string, string>[] }[] }
      ).checks.flatMap((c) =>
        c.violations.filter((v) => Object.values(v).includes(userId)),
      );
    };

    it(`funds: ${REQUESTS} withdrawals of 100,000 toman with funds for 37 → exactly 37 succeed`, async () => {
      const userId = newUser();
      await fund(userId, 3_700_000n);

      const results = await Promise.all(
        Array.from({ length: REQUESTS }, (_, i) =>
          withdraw(i, irt(userId, '100000')),
        ),
      );

      expect(tally(results.map(outcome))).toEqual({
        '201': 37,
        '422 INSUFFICIENT_FUNDS': REQUESTS - 37,
      });
      expect(await facts(userId)).toEqual({
        available: '0',
        frozen: '37000000',
        withdrawals: '37',
        usage: '37000000',
      });
      expect(await invariantViolations(userId)).toEqual([]);
    }, 120_000);

    it(`daily limit: ${REQUESTS} withdrawals of 7,000,000 toman under a 200,000,000 cap → exactly 28 succeed`, async () => {
      const userId = newUser();
      await fund(userId, 1_000_000_000n); // funds are not the limit here

      const results = await Promise.all(
        Array.from({ length: REQUESTS }, (_, i) =>
          withdraw(i, irt(userId, '7000000')),
        ),
      );

      // 28 × 7M = 196M ≤ 200M; a 29th would make 203M.
      expect(tally(results.map(outcome))).toEqual({
        '201': 28,
        '422 DAILY_LIMIT_EXCEEDED': REQUESTS - 28,
      });
      expect(await facts(userId)).toEqual({
        available: '8040000000',
        frozen: '1960000000',
        withdrawals: '28',
        usage: '1960000000',
      });
      expect(await invariantViolations(userId)).toEqual([]);
    }, 120_000);

    it(`same Idempotency-Key ×${REQUESTS} across both instances → one withdrawal, identical answers`, async () => {
      const userId = newUser();
      await fund(userId, 1_000_000n);
      const key = `x4-${randomUUID()}`;

      const results = await Promise.all(
        Array.from({ length: REQUESTS }, (_, i) =>
          withdraw(i, irt(userId, '150000'), key),
        ),
      );

      const ok = results.filter((r) => r.status === 201);
      expect(ok.length).toBeGreaterThan(0);
      expect(new Set(ok.map((r) => r.text)).size).toBe(1);
      const others = results.filter((r) => r.status !== 201).map(outcome);
      expect(others.every((o) => o === '409 IDEMPOTENCY_IN_PROGRESS')).toBe(
        true,
      );
      expect(await facts(userId)).toMatchObject({
        frozen: '1500000',
        withdrawals: '1',
      });
      expect(await invariantViolations(userId)).toEqual([]);
    }, 120_000);
  },
);
