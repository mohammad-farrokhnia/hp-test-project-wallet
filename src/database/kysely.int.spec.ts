import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DataSource } from 'typeorm';
import { connectTestDb, describeDb } from './int-testing';
import { db } from './kysely';
import { TransactionRunner } from './transaction-runner';

describeDb('db(tx): Kysely on the TransactionRunner transaction', () => {
  let ds: DataSource;
  let runner: TransactionRunner;
  // One user per test: accounts are unique per (user, kind, currency), and some tests commit.
  const createdUsers: string[] = [];
  const newUser = (): string => {
    const id = `ky_${randomUUID().slice(0, 12)}`;
    createdUsers.push(id);
    return id;
  };

  beforeAll(async () => {
    ds = await connectTestDb();
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 1234,
      statementTimeoutMs: 5000,
    });
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    await ds.query('DELETE FROM accounts WHERE user_id = ANY($1)', [
      createdUsers,
    ]);
    await ds.destroy();
  });

  const insertAccount = (tx: Parameters<typeof db>[0], userId: string) =>
    db(tx)
      .insertInto('accounts')
      .values({
        owner_type: 'USER',
        user_id: userId,
        kind: 'AVAILABLE',
        currency: 'IRR',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

  it('runs on the same session as the transaction (sees its SET LOCAL timeouts)', async () => {
    const timeout = await runner.run(async (tx) => {
      const { rows } = await sql<{
        t: string;
      }>`SELECT current_setting('lock_timeout') AS t`.execute(db(tx));
      return rows[0].t;
    });
    expect(timeout).toBe('1234ms');
  });

  it('rolls back with the transaction', async () => {
    const userId = newUser();
    await expect(
      runner.run(async (tx) => {
        await insertAccount(tx, userId);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const [{ n }] = await ds.query<{ n: string }[]>(
      'SELECT count(*) AS n FROM accounts WHERE user_id = $1',
      [userId],
    );
    expect(n).toBe('0');
  });

  it('returns UPDATE ... RETURNING rows and the affected count', async () => {
    await runner.run(async (tx) => {
      const { id } = await insertAccount(tx, newUser());
      const rows = await db(tx)
        .updateTable('accounts')
        .set({ balance_minor: 9223372036854775807n })
        .where('id', '=', id)
        .returning(sql<string>`balance_minor::text`.as('b'))
        .execute();
      expect(rows).toEqual([{ b: '9223372036854775807' }]);

      const res = await db(tx)
        .updateTable('accounts')
        .set({ balance_minor: 0 })
        .where('id', '=', id)
        .executeTakeFirst();
      expect(res.numUpdatedRows).toBe(1n);
    });
  });

  it('refuses to open its own transaction', async () => {
    await expect(
      runner.run((tx) =>
        db(tx)
          .transaction()
          .execute(() => Promise.resolve()),
      ),
    ).rejects.toThrow(/TransactionRunner/);
  });

  it('refuses to run outside a transaction', () => {
    expect(() => db(ds.manager)).toThrow(/inside runner\.run/);
  });
});
