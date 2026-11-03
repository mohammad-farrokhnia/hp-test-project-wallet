import {
  Column,
  DataSource,
  Entity,
  MigrationInterface,
  PrimaryColumn,
  QueryRunner,
} from 'typeorm';
import { bigintTransformer } from './bigint.transformer';
import { createDataSource } from './data-source';
import { runMigrations } from './migrator';
import { TransactionRunner } from './transaction-runner';

const url = process.env.DATABASE_URL;
if (url && !/_test$/.test(new URL(url).pathname.slice(1))) {
  throw new Error('database.int.spec must run against a *_test database');
}
const describeDb = url ? describe : describe.skip;
if (!url) {
  process.stderr.write(
    'database.int.spec SKIPPED: DATABASE_URL is not set (put it in .env, or use the compose test service)\n',
  );
}
const cfg = {
  db: { url: url ?? '', lockTimeoutMs: 3000, statementTimeoutMs: 5000 },
};

@Entity('it_bigint_probe')
class BigintProbe {
  @PrimaryColumn({ type: 'int' }) id!: number;
  @Column({ type: 'bigint', transformer: bigintTransformer }) amount!: bigint;
}

class ProbeMigration1700000000000 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query('CREATE TABLE it_migration_probe (id int PRIMARY KEY)');
  }
  async down(qr: QueryRunner): Promise<void> {
    await qr.query('DROP TABLE it_migration_probe');
  }
}

class Deferred {
  promise: Promise<void>;
  resolve!: () => void;
  constructor() {
    this.promise = new Promise((r) => (this.resolve = r));
  }
}

describeDb('database plumbing (real PostgreSQL)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await createDataSource(cfg, { entities: [BigintProbe] }).initialize();
    await ds.query(
      'CREATE TABLE IF NOT EXISTS it_bigint_probe (id int PRIMARY KEY, amount bigint NOT NULL)',
    );
    await ds.query(
      'CREATE TABLE IF NOT EXISTS it_lock_probe (id int PRIMARY KEY, n int NOT NULL DEFAULT 0)',
    );
  });

  afterAll(async () => {
    // beforeAll may have failed to connect; don't hide that error behind a second one.
    if (!ds?.isInitialized) return;
    await ds.query('DROP TABLE IF EXISTS it_bigint_probe, it_lock_probe');
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE it_bigint_probe, it_lock_probe');
    await ds.query('INSERT INTO it_lock_probe (id) VALUES (1), (2)');
  });

  describe('BIGINT transformer', () => {
    const edges = [
      0n,
      1n,
      -1n,
      9_007_199_254_740_992n, // 2^53: last integer a JS number holds exactly
      9_007_199_254_740_993n, // 2^53 + 1: a JS number would round this
      9_223_372_036_854_775_807n, // 2^63 - 1
      -9_223_372_036_854_775_808n, // -2^63
    ];

    it.each(edges)(
      'round-trips %s through an entity without loss',
      async (v) => {
        const repo = ds.getRepository(BigintProbe);
        await repo.insert({ id: 1, amount: v });

        expect((await repo.findOneByOrFail({ id: 1 })).amount).toBe(v);
        const [raw] = await ds.query<{ t: string }[]>(
          'SELECT amount::text AS t FROM it_bigint_probe WHERE id = 1',
        );
        expect(raw.t).toBe(v.toString());
      },
    );

    it('lets PostgreSQL reject a value past 2^63 - 1 instead of wrapping', async () => {
      await expect(
        ds.getRepository(BigintProbe).insert({ id: 1, amount: 2n ** 63n }),
      ).rejects.toMatchObject({ driverError: { code: '22003' } });
    });
  });

  describe('TransactionRunner', () => {
    const runner = () =>
      new TransactionRunner(ds, {
        lockTimeoutMs: 5000,
        statementTimeoutMs: 10_000,
        retryBackoffMs: 5,
      });

    it('retries a forced deadlock and both transactions commit', async () => {
      const attempts = { a: 0, b: 0 };
      // Each worker takes its first row, then waits until the other holds
      // theirs: a guaranteed lock cycle on the first attempt only.
      const bothHoldOne = [new Deferred(), new Deferred()];
      const worker = (
        name: 'a' | 'b',
        first: number,
        second: number,
        i: 0 | 1,
      ) =>
        runner().run(async (tx) => {
          attempts[name]++;
          await tx.query('UPDATE it_lock_probe SET n = n + 1 WHERE id = $1', [
            first,
          ]);
          if (attempts[name] === 1) {
            bothHoldOne[i].resolve();
            await bothHoldOne[1 - i].promise;
          }
          await tx.query('UPDATE it_lock_probe SET n = n + 1 WHERE id = $1', [
            second,
          ]);
        });

      await Promise.all([worker('a', 1, 2, 0), worker('b', 2, 1, 1)]);

      expect(attempts.a + attempts.b).toBe(3);
      const rows = await ds.query<{ id: number; n: number }[]>(
        'SELECT id, n FROM it_lock_probe ORDER BY id',
      );
      expect(rows).toEqual([
        { id: 1, n: 2 },
        { id: 2, n: 2 },
      ]);
    }, 20_000);

    it('fails fast on lock timeout (55P03) without retrying', async () => {
      const held = new Deferred();
      const release = new Deferred();
      const holder = runner().run(async (tx) => {
        await tx.query('UPDATE it_lock_probe SET n = 9 WHERE id = 1');
        held.resolve();
        await release.promise;
      });
      await held.promise;

      let attempts = 0;
      const impatient = new TransactionRunner(ds, {
        lockTimeoutMs: 200,
        statementTimeoutMs: 10_000,
      });
      await expect(
        impatient.run(async (tx) => {
          attempts++;
          await tx.query('UPDATE it_lock_probe SET n = 1 WHERE id = 1');
        }),
      ).rejects.toMatchObject({ driverError: { code: '55P03' } });
      expect(attempts).toBe(1);

      release.resolve();
      await holder;
    });

    it('rolls everything back when the function throws', async () => {
      await expect(
        runner().run(async (tx) => {
          await tx.query('UPDATE it_lock_probe SET n = 5 WHERE id = 1');
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const [row] = await ds.query<{ n: number }[]>(
        'SELECT n FROM it_lock_probe WHERE id = 1',
      );
      expect(row.n).toBe(0);
    });

    it('scopes the timeouts to the transaction (SET LOCAL)', async () => {
      const inside = await runner().run((tx) =>
        tx.query<{ lock_timeout: string }[]>('SHOW lock_timeout'),
      );
      expect(inside[0].lock_timeout).toBe('5s');
      const [after] =
        await ds.query<{ lock_timeout: string }[]>('SHOW lock_timeout');
      expect(after.lock_timeout).not.toBe('5s');
    });
  });

  describe('migration runner', () => {
    const migrationSource = () =>
      createDataSource(cfg, {
        migrations: [ProbeMigration1700000000000],
        migrationsTableName: 'it_migrations_probe',
      });

    afterEach(async () => {
      if (!ds?.isInitialized) return;
      await ds.query(
        'DROP TABLE IF EXISTS it_migration_probe, it_migrations_probe',
      );
    });

    it('applies pending migrations once and is a no-op afterwards', async () => {
      const m = await migrationSource().initialize();
      try {
        expect(await runMigrations(m)).toEqual(['ProbeMigration1700000000000']);
        expect(await runMigrations(m)).toEqual([]);
        await expect(
          ds.query('SELECT 1 FROM it_migration_probe'),
        ).resolves.toBeDefined();
      } finally {
        await m.destroy();
      }
    });

    it('lets only one of several concurrent migrators apply a migration', async () => {
      const sources = await Promise.all(
        [1, 2, 3].map(() => migrationSource().initialize()),
      );
      try {
        const results = await Promise.all(sources.map((s) => runMigrations(s)));
        expect(results.flat()).toEqual(['ProbeMigration1700000000000']);
      } finally {
        await Promise.all(sources.map((s) => s.destroy()));
      }
    });
  });
});
