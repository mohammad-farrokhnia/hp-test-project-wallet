import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { TransactionRunner } from '../../database/transaction-runner';
import { newLedgerService } from './testing';

describeDb('LedgerService.ensureUserAccounts (real PostgreSQL)', () => {
  let ds: DataSource;
  let runner: TransactionRunner;
  const ledger = newLedgerService();
  const createdUsers: string[] = [];

  const newUser = (): string => {
    const id = `l2_${randomUUID().slice(0, 12)}`;
    createdUsers.push(id);
    return id;
  };

  beforeAll(async () => {
    ds = await connectTestDb();
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 5000,
      statementTimeoutMs: 10_000,
    });
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query('DELETE FROM accounts WHERE user_id = ANY($1)', [
      createdUsers,
    ]);
    await ds.destroy();
  });

  const countFor = async (userId: string): Promise<number> => {
    const [row] = await ds.query<{ n: string }[]>(
      'SELECT count(*) AS n FROM accounts WHERE user_id = $1',
      [userId],
    );
    return parseInt(row.n, 10);
  };

  it('creates AVAILABLE, FROZEN and DEBT on first use', async () => {
    const userId = newUser();
    const ids = await runner.run((tx) =>
      ledger.ensureUserAccounts(tx, userId, 'IRR'),
    );
    expect(new Set([ids.available, ids.frozen, ids.debt]).size).toBe(3);
    const rows = await ds.query<{ kind: string; balance: string }[]>(
      `SELECT kind, balance_minor::text AS balance FROM accounts WHERE user_id = $1 ORDER BY kind`,
      [userId],
    );
    expect(rows).toEqual([
      { kind: 'AVAILABLE', balance: '0' },
      { kind: 'DEBT', balance: '0' },
      { kind: 'FROZEN', balance: '0' },
    ]);
  });

  it('returns the same ids on every later call and writes nothing', async () => {
    const userId = newUser();
    // Per-user row versions, not the global accounts_id_seq: other suites share
    // this database and advance that sequence while this one runs.
    const versions = () =>
      ds.query<{ id: string; xmin: string }[]>(
        'SELECT id::text, xmin::text FROM accounts WHERE user_id = $1 ORDER BY id',
        [userId],
      );
    const first = await runner.run((tx) =>
      ledger.ensureUserAccounts(tx, userId, 'IRR'),
    );
    const before = await versions();
    const again = await runner.run((tx) =>
      ledger.ensureUserAccounts(tx, userId, 'IRR'),
    );
    expect(again).toEqual(first);
    expect(await versions()).toEqual(before);
  });

  it('keeps one account set per currency', async () => {
    const userId = newUser();
    const irr = await runner.run((tx) =>
      ledger.ensureUserAccounts(tx, userId, 'IRR'),
    );
    const usdt = await runner.run((tx) =>
      ledger.ensureUserAccounts(tx, userId, 'USDT'),
    );
    expect(usdt.available).not.toBe(irr.available);
    expect(await countFor(userId)).toBe(6);
  });

  it('creates exactly one account set for 50 parallel first uses', async () => {
    const userId = newUser();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        runner.run((tx) => ledger.ensureUserAccounts(tx, userId, 'IRR')),
      ),
    );
    expect(await countFor(userId)).toBe(3);
    for (const ids of results) expect(ids).toEqual(results[0]);
  }, 30_000);

  it('survives 50 parallel first uses across both currencies and several users', async () => {
    const users = [newUser(), newUser(), newUser()];
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        runner.run((tx) =>
          ledger.ensureUserAccounts(
            tx,
            users[i % users.length],
            i % 2 ? 'USDT' : 'IRR',
          ),
        ),
      ),
    );
    for (const userId of users) expect(await countFor(userId)).toBe(6);
  }, 30_000);

  it('leaves no accounts behind when the caller rolls back', async () => {
    const userId = newUser();
    await expect(
      runner.run(async (tx) => {
        await ledger.ensureUserAccounts(tx, userId, 'IRR');
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await countFor(userId)).toBe(0);
  });
});
