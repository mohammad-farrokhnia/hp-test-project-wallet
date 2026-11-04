import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { databaseUrlFromEnv } from '../config/database-url';
import { createDataSource } from './data-source';
import { runMigrations } from './migrator';

const url = databaseUrlFromEnv();
if (url && !/_test$/.test(new URL(url).pathname.slice(1))) {
  throw new Error('ledger-schema.int.spec must run against a *_test database');
}
const describeDb = url ? describe : describe.skip;
if (!url) {
  process.stderr.write(
    'ledger-schema.int.spec SKIPPED: POSTGRES_DB is not set (put it in .env, or use the compose test service)\n',
  );
}

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';

type JournalKind =
  | 'DEPOSIT_CREDIT'
  | 'ADJUSTMENT_CREDIT'
  | 'WITHDRAWAL_FREEZE'
  | 'WITHDRAWAL_SETTLE'
  | 'WITHDRAWAL_RELEASE'
  | 'TRANSFER';

const REF_TYPE: Record<JournalKind, string> = {
  DEPOSIT_CREDIT: 'DEPOSIT',
  ADJUSTMENT_CREDIT: 'ADJUSTMENT',
  WITHDRAWAL_FREEZE: 'WITHDRAWAL',
  WITHDRAWAL_SETTLE: 'WITHDRAWAL',
  WITHDRAWAL_RELEASE: 'WITHDRAWAL',
  TRANSFER: 'TRANSFER',
};

interface PostingInput {
  accountId: string;
  amount: bigint;
  currency?: string;
}

describeDb('ledger schema (real PostgreSQL)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = await createDataSource({
      db: { url: url ?? '', lockTimeoutMs: 3000, statementTimeoutMs: 5000 },
    }).initialize();
    await runMigrations(ds);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  /**
   * Runs `fn` inside a transaction that is always rolled back, so the append-only tables stay clean.
   */
  async function sandbox(
    fn: (qr: QueryRunner) => Promise<void>,
  ): Promise<void> {
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await fn(qr);
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  }

  async function systemAccount(
    qr: QueryRunner,
    kind: string,
    currency = 'IRR',
  ): Promise<string> {
    const rows = await qr.manager.query<{ id: string }[]>(
      `SELECT id FROM accounts WHERE owner_type = 'SYSTEM' AND kind = $1 AND currency = $2`,
      [kind, currency],
    );
    return rows[0].id;
  }

  async function userAccount(
    qr: QueryRunner,
    userId: string,
    kind: string,
    currency = 'IRR',
  ): Promise<string> {
    const rows = await qr.manager.query<{ id: string }[]>(
      `INSERT INTO accounts (owner_type, user_id, kind, currency)
       VALUES ('USER', $1, $2, $3) RETURNING id`,
      [userId, kind, currency],
    );
    return rows[0].id;
  }

  async function journal(
    qr: QueryRunner,
    kind: JournalKind = 'DEPOSIT_CREDIT',
    refId: string = randomUUID(),
    currency = 'IRR',
  ): Promise<string> {
    const rows = await qr.manager.query<{ id: string }[]>(
      `INSERT INTO journals (kind, ref_type, ref_id, currency) VALUES ($1, $2, $3, $4) RETURNING id`,
      [kind, REF_TYPE[kind], refId, currency],
    );
    return rows[0].id;
  }

  async function posting(
    qr: QueryRunner,
    journalId: string,
    { accountId, amount, currency = 'IRR' }: PostingInput,
  ): Promise<void> {
    await qr.query(
      `INSERT INTO postings (journal_id, account_id, user_id, account_kind, currency, amount_minor, balance_after_minor)
       SELECT $1, a.id, a.user_id, a.kind, $3, $4, $4 FROM accounts a WHERE a.id = $2`,
      [journalId, accountId, currency, amount.toString()],
    );
  }

  async function balancedDeposit(qr: QueryRunner): Promise<{
    journalId: string;
    userId: string;
    postingId: string;
  }> {
    const userId = `u${randomUUID().slice(0, 8)}`;
    const available = await userAccount(qr, userId, 'AVAILABLE');
    const clearing = await systemAccount(qr, 'PSP_CLEARING');
    const journalId = await journal(qr);
    await posting(qr, journalId, { accountId: clearing, amount: -1000n });
    await posting(qr, journalId, { accountId: available, amount: 1000n });
    const [row] = await qr.manager.query<{ id: string }[]>(
      'SELECT max(id) AS id FROM postings WHERE journal_id = $1',
      [journalId],
    );
    return { journalId, userId, postingId: row.id };
  }

  const settle = (qr: QueryRunner) => qr.query('SET CONSTRAINTS ALL IMMEDIATE');

  describe('seeded system accounts', () => {
    it('holds every system kind in both currencies with a zero balance', async () => {
      const rows = await ds.query<
        { kind: string; currency: string; balance: string; neg: boolean }[]
      >(
        `SELECT kind, currency, balance_minor::text AS balance, allow_negative AS neg
           FROM accounts WHERE owner_type = 'SYSTEM' ORDER BY kind, currency`,
      );
      expect(rows.map((r) => `${r.kind}/${r.currency}`)).toEqual([
        'FEE_REVENUE/IRR',
        'FEE_REVENUE/USDT',
        'OPS_ADJUSTMENTS/IRR',
        'OPS_ADJUSTMENTS/USDT',
        'PAYOUT_CLEARING/IRR',
        'PAYOUT_CLEARING/USDT',
        'PSP_CLEARING/IRR',
        'PSP_CLEARING/USDT',
      ]);
      expect(rows.every((r) => r.balance === '0' && r.neg)).toBe(true);
    });

    it('refuses a second copy of a system account (NULLS NOT DISTINCT)', async () => {
      await sandbox(async (qr) => {
        await expect(
          qr.query(
            `INSERT INTO accounts (owner_type, kind, currency) VALUES ('SYSTEM', 'PSP_CLEARING', 'IRR')`,
          ),
        ).rejects.toMatchObject({ driverError: { code: UNIQUE_VIOLATION } });
      });
    });
  });

  describe('zero-sum journals', () => {
    it('accepts a balanced journal at commit', async () => {
      await sandbox(async (qr) => {
        await balancedDeposit(qr);
        await expect(settle(qr)).resolves.toBeDefined();
      });
    });

    it('rejects an unbalanced journal at COMMIT, leaving nothing behind', async () => {
      const refId = randomUUID();
      const qr = ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      const userId = `u${randomUUID().slice(0, 8)}`;
      const available = await userAccount(qr, userId, 'AVAILABLE');
      const clearing = await systemAccount(qr, 'PSP_CLEARING');
      const journalId = await journal(qr, 'DEPOSIT_CREDIT', refId);
      await posting(qr, journalId, { accountId: clearing, amount: -999n });
      await posting(qr, journalId, { accountId: available, amount: 1000n });

      await expect(qr.commitTransaction()).rejects.toMatchObject({
        driverError: { code: CHECK_VIOLATION },
      });
      await qr.release();

      const left = await ds.query<{ n: string }[]>(
        'SELECT count(*) AS n FROM journals WHERE ref_id = $1',
        [refId],
      );
      expect(left[0].n).toBe('0');
    });

    it('rejects a journal with a single posting', async () => {
      await sandbox(async (qr) => {
        const clearing = await systemAccount(qr, 'PSP_CLEARING');
        const journalId = await journal(qr);
        await posting(qr, journalId, { accountId: clearing, amount: -5n });
        await expect(settle(qr)).rejects.toMatchObject({
          driverError: { code: CHECK_VIOLATION },
        });
      });
    });

    it('rejects a journal with no postings', async () => {
      await sandbox(async (qr) => {
        await journal(qr);
        await expect(settle(qr)).rejects.toMatchObject({
          driverError: { code: CHECK_VIOLATION },
          message: expect.stringContaining('at least two postings') as string,
        });
      });
    });

    it('rejects postings whose currency differs from the journal', async () => {
      await sandbox(async (qr) => {
        const from = await systemAccount(qr, 'PSP_CLEARING', 'USDT');
        const to = await systemAccount(qr, 'OPS_ADJUSTMENTS', 'USDT');
        const journalId = await journal(
          qr,
          'ADJUSTMENT_CREDIT',
          undefined,
          'IRR',
        );
        await posting(qr, journalId, {
          accountId: from,
          amount: -7n,
          currency: 'USDT',
        });
        await posting(qr, journalId, {
          accountId: to,
          amount: 7n,
          currency: 'USDT',
        });
        await expect(settle(qr)).rejects.toMatchObject({
          driverError: { code: CHECK_VIOLATION },
        });
      });
    });

    it('rejects a zero-amount posting', async () => {
      await sandbox(async (qr) => {
        const clearing = await systemAccount(qr, 'PSP_CLEARING');
        const journalId = await journal(qr);
        await expect(
          posting(qr, journalId, { accountId: clearing, amount: 0n }),
        ).rejects.toMatchObject({ driverError: { code: CHECK_VIOLATION } });
      });
    });

    it('rejects a posting whose currency differs from its account', async () => {
      await sandbox(async (qr) => {
        const irrAccount = await systemAccount(qr, 'PSP_CLEARING', 'IRR');
        const journalId = await journal(
          qr,
          'DEPOSIT_CREDIT',
          undefined,
          'USDT',
        );
        await expect(
          posting(qr, journalId, {
            accountId: irrAccount,
            amount: 5n,
            currency: 'USDT',
          }),
        ).rejects.toMatchObject({
          driverError: { code: FOREIGN_KEY_VIOLATION },
        });
      });
    });

    it('rejects a posting whose copied user_id or kind disagrees with its account', async () => {
      await sandbox(async (qr) => {
        const userId = `u${randomUUID().slice(0, 8)}`;
        const available = await userAccount(qr, userId, 'AVAILABLE');
        const journalId = await journal(qr);
        await expect(
          qr.query(
            `INSERT INTO postings (journal_id, account_id, user_id, account_kind, currency, amount_minor, balance_after_minor)
             VALUES ($1, $2, $3, 'FROZEN', 'IRR', 5, 5)`,
            [journalId, available, userId],
          ),
        ).rejects.toMatchObject({
          driverError: { code: FOREIGN_KEY_VIOLATION },
        });
      });
    });
  });

  describe('append-only history', () => {
    it.each([
      [
        'UPDATE postings',
        'UPDATE postings SET amount_minor = amount_minor + 1',
      ],
      ['DELETE postings', 'DELETE FROM postings'],
      ['UPDATE journals', `UPDATE journals SET description = 'edited'`],
      ['DELETE journals', 'DELETE FROM journals'],
    ])('rejects %s', async (_name, statement) => {
      await sandbox(async (qr) => {
        const { journalId, postingId } = await balancedDeposit(qr);
        await settle(qr);
        const scoped = statement.includes('postings')
          ? `${statement} WHERE id = ${postingId}`
          : `${statement} WHERE id = ${journalId}`;
        await expect(qr.query(scoped)).rejects.toMatchObject({
          driverError: { code: RESTRICT_VIOLATION },
        });
      });
    });
  });

  describe('account balances', () => {
    it.each(['AVAILABLE', 'FROZEN'])(
      'rejects a negative %s balance',
      async (kind) => {
        await sandbox(async (qr) => {
          const id = await userAccount(qr, 'alice', kind);
          await expect(
            qr.query('UPDATE accounts SET balance_minor = -1 WHERE id = $1', [
              id,
            ]),
          ).rejects.toMatchObject({ driverError: { code: CHECK_VIOLATION } });
        });
      },
    );

    it('lets DEBT go negative but never positive', async () => {
      await sandbox(async (qr) => {
        const id = await userAccount(qr, 'alice', 'DEBT');
        await qr.query('UPDATE accounts SET balance_minor = -5 WHERE id = $1', [
          id,
        ]);
        await expect(
          qr.query('UPDATE accounts SET balance_minor = 1 WHERE id = $1', [id]),
        ).rejects.toMatchObject({ driverError: { code: CHECK_VIOLATION } });
      });
    });

    it('lets a system account go negative', async () => {
      await sandbox(async (qr) => {
        const id = await systemAccount(qr, 'PSP_CLEARING');
        await expect(
          qr.query(
            'UPDATE accounts SET balance_minor = -50000000 WHERE id = $1',
            [id],
          ),
        ).resolves.toBeDefined();
      });
    });

    it('stores balances beyond 2^53 without loss', async () => {
      await sandbox(async (qr) => {
        const id = await userAccount(qr, 'alice', 'AVAILABLE');
        const [rows] = await qr.manager.query<[{ b: string }[], number]>(
          `UPDATE accounts SET balance_minor = 9223372036854775807 WHERE id = $1 RETURNING balance_minor::text AS b`,
          [id],
        );
        expect(rows[0].b).toBe('9223372036854775807');
      });
    });

    it('refreshes updated_at on every change', async () => {
      await sandbox(async (qr) => {
        const id = await userAccount(qr, 'alice', 'AVAILABLE');
        const [rows] = await qr.manager.query<[{ moved: boolean }[], number]>(
          `UPDATE accounts SET balance_minor = 1, updated_at = '2000-01-01'
            WHERE id = $1 RETURNING updated_at > '2000-01-01' AS moved`,
          [id],
        );
        expect(rows[0].moved).toBe(true);
      });
    });
  });

  describe('account shape', () => {
    it('refuses a user account with a system kind', async () => {
      await sandbox(async (qr) => {
        await expect(
          userAccount(qr, 'alice', 'PSP_CLEARING'),
        ).rejects.toMatchObject({ driverError: { code: CHECK_VIOLATION } });
      });
    });

    it('refuses a system account that carries a user id', async () => {
      await sandbox(async (qr) => {
        await expect(
          qr.query(
            `INSERT INTO accounts (owner_type, user_id, kind, currency) VALUES ('SYSTEM', 'alice', 'FEE_REVENUE', 'USDT')`,
          ),
        ).rejects.toMatchObject({ driverError: { code: CHECK_VIOLATION } });
      });
    });

    it('refuses a malformed user id and an unknown currency', async () => {
      await sandbox(async (qr) => {
        await expect(
          userAccount(qr, 'bad id!', 'AVAILABLE'),
        ).rejects.toMatchObject({ driverError: { code: CHECK_VIOLATION } });
      });
      await sandbox(async (qr) => {
        await expect(
          userAccount(qr, 'alice', 'AVAILABLE', 'EUR'),
        ).rejects.toMatchObject({ driverError: { code: CHECK_VIOLATION } });
      });
    });

    it('allows one account of each kind per user and currency, and no more', async () => {
      await sandbox(async (qr) => {
        await userAccount(qr, 'alice', 'AVAILABLE', 'IRR');
        await userAccount(qr, 'alice', 'AVAILABLE', 'USDT');
        await expect(
          userAccount(qr, 'alice', 'AVAILABLE', 'IRR'),
        ).rejects.toMatchObject({ driverError: { code: UNIQUE_VIOLATION } });
      });
    });

    it('derives allow_negative and refuses to set it', async () => {
      await sandbox(async (qr) => {
        const id = await userAccount(qr, 'alice', 'AVAILABLE');
        await expect(
          qr.query('UPDATE accounts SET allow_negative = true WHERE id = $1', [
            id,
          ]),
        ).rejects.toBeDefined();
      });
    });
  });

  describe('journal uniqueness', () => {
    it('refuses to book the same event twice', async () => {
      await sandbox(async (qr) => {
        const refId = randomUUID();
        await journal(qr, 'DEPOSIT_CREDIT', refId);
        await expect(
          journal(qr, 'DEPOSIT_CREDIT', refId),
        ).rejects.toMatchObject({
          driverError: { code: UNIQUE_VIOLATION },
        });
      });
    });

    it('settles or releases a withdrawal, never both', async () => {
      await sandbox(async (qr) => {
        const withdrawalId = randomUUID();
        await journal(qr, 'WITHDRAWAL_SETTLE', withdrawalId);
        await expect(
          journal(qr, 'WITHDRAWAL_RELEASE', withdrawalId),
        ).rejects.toMatchObject({ driverError: { code: UNIQUE_VIOLATION } });
      });
    });

    it('still allows freeze and settle of the same withdrawal', async () => {
      await sandbox(async (qr) => {
        const withdrawalId = randomUUID();
        await journal(qr, 'WITHDRAWAL_FREEZE', withdrawalId);
        await expect(
          journal(qr, 'WITHDRAWAL_SETTLE', withdrawalId),
        ).resolves.toEqual(expect.any(String));
      });
    });

    it('refuses a kind that does not match its reference type', async () => {
      await sandbox(async (qr) => {
        await expect(
          qr.query(
            `INSERT INTO journals (kind, ref_type, ref_id, currency) VALUES ('DEPOSIT_CREDIT', 'WITHDRAWAL', $1, 'IRR')`,
            [randomUUID()],
          ),
        ).rejects.toMatchObject({ driverError: { code: CHECK_VIOLATION } });
      });
    });
  });

  describe('hot-path indexes', () => {
    it('has the history, per-account and per-journal indexes on postings', async () => {
      const rows = await ds.query<{ indexname: string; indexdef: string }[]>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'postings'`,
      );
      const defs = rows.map((r) => r.indexdef).join('\n');
      expect(defs).toContain('(user_id, id DESC) WHERE (user_id IS NOT NULL)');
      expect(defs).toContain('(account_id, id DESC)');
      expect(defs).toContain('(journal_id)');
    });

    it('stores accounts with fillfactor 90', async () => {
      const [row] = await ds.query<{ reloptions: string[] }[]>(
        `SELECT reloptions FROM pg_class WHERE relname = 'accounts'`,
      );
      expect(row.reloptions).toContain('fillfactor=90');
    });
  });
});
