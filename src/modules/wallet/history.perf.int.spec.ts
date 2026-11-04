import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { TransactionRunner } from '../../database/transaction-runner';
import { newLedgerService } from '../ledger/testing';
import { decodeCursor } from './domain/history-query';
import { WalletService } from './wallet.service';

const POSTINGS = 1_000_000;
const PAGE_SIZE = 20;
const TARGET_PAGE = 1_000;
const BUDGET_US = 50_000n; // 50 ms, in whole microseconds: no floats, even for timings

/**
 * W2 "done when": page 1,000 of a user with a million postings returns in under 50 ms.
 * The million postings are seeded inside a transaction that is rolled back, so the shared
 * test database never grows, and the deferred commit triggers never run over them.
 */
// Seeding a million rows takes about a minute, so this runs on demand: `npm run test:perf`.
const describePerf = process.env.PERF === '1' ? describeDb : describe.skip;

describePerf('wallet history at scale (real PostgreSQL)', () => {
  let ds: DataSource;
  let qr: QueryRunner;
  const ledger = newLedgerService();
  const userId = `w2_${randomUUID().slice(0, 12)}`;
  let wallet: WalletService;

  beforeAll(async () => {
    ds = await connectTestDb();
    wallet = new WalletService(
      new TransactionRunner(ds, {
        lockTimeoutMs: 5000,
        statementTimeoutMs: 60_000,
      }),
      ledger,
    );
    qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    const ids = await ledger.ensureUserAccounts(qr.manager, userId, 'IRR');
    await qr.query(
      `WITH j AS (
         INSERT INTO journals (kind, ref_type, ref_id, currency)
         SELECT 'WITHDRAWAL_FREEZE', 'WITHDRAWAL', gen_random_uuid(), 'IRR'
           FROM generate_series(1, $1::int)
         RETURNING id)
       INSERT INTO postings (journal_id, account_id, user_id, account_kind, currency, amount_minor, balance_after_minor)
       SELECT j.id, x.account_id, $2, x.kind, 'IRR', x.amount, 0
         FROM j
        CROSS JOIN (VALUES ($3::bigint, 'AVAILABLE', -1), ($4::bigint, 'FROZEN', 1)) AS x(account_id, kind, amount)
        ORDER BY j.id, x.kind`,
      [POSTINGS / 2, userId, ids.available.toString(), ids.frozen.toString()],
    );
    await qr.query('ANALYZE postings, journals');
  }, 180_000);

  afterAll(async () => {
    if (qr) {
      await qr.rollbackTransaction();
      await qr.release();
    }
    if (ds?.isInitialized) await ds.destroy();
  });

  const page = (beforeId: bigint | undefined) =>
    wallet.historyIn(qr.manager, userId, beforeId, PAGE_SIZE);

  it(`page ${TARGET_PAGE} of a ${POSTINGS.toLocaleString('en')}-posting user returns in under 50 ms`, async () => {
    let before: bigint | undefined;
    let lastId = BigInt(Number.MAX_SAFE_INTEGER) ** 2n;
    for (let p = 1; p < TARGET_PAGE; p++) {
      const { items, nextCursor } = await page(before);
      expect(items).toHaveLength(PAGE_SIZE);
      for (const item of items) {
        const id = BigInt(item.id);
        expect(id < lastId).toBe(true);
        lastId = id;
      }
      before = decodeCursor(nextCursor!);
    }

    const timingsUs: bigint[] = [];
    for (let run = 0; run < 5; run++) {
      const start = process.hrtime.bigint();
      const { items } = await page(before);
      timingsUs.push((process.hrtime.bigint() - start) / 1000n);
      expect(items).toHaveLength(PAGE_SIZE);
    }
    const median = [...timingsUs].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    )[2];
    process.stdout.write(
      `W2: page ${TARGET_PAGE} median ${median} µs (runs: ${timingsUs.join(', ')} µs)\n`,
    );
    expect(median < BUDGET_US).toBe(true);
  }, 180_000);

  it('the page query walks an index in id order and stops after one page: no sort, no bitmap, no seq scan', async () => {
    const spy = jest.spyOn(qr, 'query');
    await page(123_456n);
    const [sql, params] = spy.mock.calls.at(-1)!;
    spy.mockRestore();

    const rows = (await qr.query(`EXPLAIN ${sql}`, params as unknown[])) as {
      'QUERY PLAN': string;
    }[];
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(
      /Index Scan Backward using postings_(user_history_idx|pkey) on postings/,
    );
    expect(plan).not.toMatch(/Sort|Bitmap|Seq Scan/);
  });
});
