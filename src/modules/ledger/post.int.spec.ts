import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Money } from '../../common/money';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { Tx, TransactionRunner } from '../../database/transaction-runner';
import { LedgerService } from './ledger.service';
import { newLedgerService } from './testing';

describeDb('LedgerService.post (real PostgreSQL)', () => {
  let ds: DataSource;
  let runner: TransactionRunner;
  const ledger: LedgerService = newLedgerService();

  const newUser = (): string => `l3_${randomUUID().slice(0, 12)}`;

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

  const credit = (tx: Tx, userId: string, rial: bigint, refId = randomUUID()) =>
    (async () => {
      const user = await ledger.ensureUserAccounts(tx, userId, 'IRR');
      const ops = await ledger.systemAccountId(tx, 'OPS_ADJUSTMENTS', 'IRR');
      return ledger.post(tx, {
        kind: 'ADJUSTMENT_CREDIT',
        refId,
        currency: 'IRR',
        description: 'test credit',
        lines: [
          { accountId: ops, amount: Money.rial(-rial) },
          { accountId: user.available, amount: Money.rial(rial) },
        ],
      });
    })();

  const transfer = (tx: Tx, from: string, to: string, rial: bigint) =>
    (async () => {
      const a = await ledger.ensureUserAccounts(tx, from, 'IRR');
      const b = await ledger.ensureUserAccounts(tx, to, 'IRR');
      return ledger.post(tx, {
        kind: 'TRANSFER',
        refId: randomUUID(),
        currency: 'IRR',
        lines: [
          { accountId: a.available, amount: Money.rial(-rial) },
          { accountId: b.available, amount: Money.rial(rial) },
        ],
      });
    })();

  /** Read straight from the tables, independent of the code under test. */
  const accountState = async (userId: string) => {
    const [row] = await ds.query<
      { balance: string; postings_sum: string; postings: string }[]
    >(
      `SELECT a.balance_minor::text AS balance,
              COALESCE(sum(p.amount_minor), 0)::text AS postings_sum,
              count(p.id)::text AS postings
         FROM accounts a
         LEFT JOIN postings p ON p.account_id = a.id
        WHERE a.user_id = $1 AND a.kind = 'AVAILABLE' AND a.currency = 'IRR'
        GROUP BY a.id`,
      [userId],
    );
    return row;
  };

  const brokenBalanceAfterChain = async (userId: string) => {
    const rows = await ds.query<{ id: string }[]>(
      `SELECT id::text FROM (
         SELECT p.id, p.balance_after_minor,
                sum(p.amount_minor) OVER (PARTITION BY p.account_id ORDER BY p.id) AS running
           FROM postings p WHERE p.user_id = $1) x
        WHERE balance_after_minor <> running`,
      [userId],
    );
    return rows.map((r) => r.id);
  };

  it('books a journal: postings carry balance_after and balances move with them', async () => {
    const alice = newUser();
    const bob = newUser();
    await runner.run((tx) => credit(tx, alice, 1_000n));
    const { journalId, alreadyBooked } = await runner.run((tx) =>
      transfer(tx, alice, bob, 300n),
    );

    expect(alreadyBooked).toBe(false);
    const postings = await ds.query<
      { user_id: string; amount: string; after: string }[]
    >(
      `SELECT user_id, amount_minor::text AS amount, balance_after_minor::text AS after
         FROM postings WHERE journal_id = $1 ORDER BY id`,
      [journalId.toString()],
    );
    expect(postings).toEqual([
      { user_id: alice, amount: '-300', after: '700' },
      { user_id: bob, amount: '300', after: '300' },
    ]);
    const [journal] = await ds.query<{ ref_type: string }[]>(
      'SELECT ref_type FROM journals WHERE id = $1',
      [journalId.toString()],
    );
    expect(journal.ref_type).toBe('TRANSFER');
    expect((await accountState(alice)).balance).toBe('700');
    expect((await accountState(bob)).balance).toBe('300');
  });

  it('books the same (kind, ref) once: a repeat returns the first journal and writes nothing', async () => {
    const user = newUser();
    const refId = randomUUID();
    const first = await runner.run((tx) => credit(tx, user, 500n, refId));
    const again = await runner.run((tx) => credit(tx, user, 500n, refId));

    expect(again).toEqual({ journalId: first.journalId, alreadyBooked: true });
    expect(await accountState(user)).toEqual({
      balance: '500',
      postings_sum: '500',
      postings: '1',
    });
  });

  it('refuses an overdraft and leaves nothing behind', async () => {
    const alice = newUser();
    const bob = newUser();
    await runner.run((tx) => credit(tx, alice, 100n));

    await expect(
      runner.run((tx) => transfer(tx, alice, bob, 101n)),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect((await accountState(alice)).balance).toBe('100');
    expect(await accountState(bob)).toBeUndefined();
  });

  it('concurrent posts in both directions never deadlock and leave balances equal to the sum of postings', async () => {
    const alice = newUser();
    const bob = newUser();
    await runner.run((tx) => credit(tx, alice, 10_000n));
    await runner.run((tx) => credit(tx, bob, 10_000n));

    const jobs = Array.from({ length: 100 }, (_, i) => {
      const amount = BigInt((i % 7) + 1);
      if (i % 10 === 9) {
        return runner.run((tx) => credit(tx, i % 2 ? alice : bob, amount), {
          retries: 0,
        });
      }
      const [from, to] = i % 2 ? [alice, bob] : [bob, alice];
      return runner.run((tx) => transfer(tx, from, to, amount), {
        retries: 0,
      });
    });
    const results = await Promise.allSettled(jobs);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

    const credited = Array.from({ length: 100 }, (_, i) => i)
      .filter((i) => i % 10 === 9)
      .reduce((sum, i) => sum + BigInt((i % 7) + 1), 0n);
    const a = await accountState(alice);
    const b = await accountState(bob);
    expect(a.balance).toBe(a.postings_sum);
    expect(b.balance).toBe(b.postings_sum);
    expect(BigInt(a.balance) + BigInt(b.balance)).toBe(20_000n + credited);
    expect(await brokenBalanceAfterChain(alice)).toEqual([]);
    expect(await brokenBalanceAfterChain(bob)).toEqual([]);
  });

  it('20 concurrent posts of the same event book exactly one journal', async () => {
    const user = newUser();
    const refId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        runner.run((tx) => credit(tx, user, 250n, refId)),
      ),
    );

    expect(new Set(results.map((r) => r.journalId)).size).toBe(1);
    expect(results.filter((r) => !r.alreadyBooked)).toHaveLength(1);
    expect(await accountState(user)).toEqual({
      balance: '250',
      postings_sum: '250',
      postings: '1',
    });
  });
});
