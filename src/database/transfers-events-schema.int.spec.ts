import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { connectTestDb, describeDb } from './int-testing';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

describeDb(
  'transfers, inbox and notifications schema (real PostgreSQL)',
  () => {
    let ds: DataSource;

    beforeAll(async () => {
      ds = await connectTestDb();
    });

    afterAll(async () => {
      if (ds?.isInitialized) await ds.destroy();
    });

    /** Runs `fn` in a transaction that is always rolled back. */
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
    const code = (err: unknown) =>
      (err as { driverError?: { code?: string } }).driverError?.code;
    const refused = async (
      run: (qr: QueryRunner) => Promise<unknown>,
      expected: string,
    ) => {
      await sandbox(async (qr) => {
        let thrown: unknown;
        try {
          await run(qr);
        } catch (err) {
          thrown = err;
        }
        expect(code(thrown)).toBe(expected);
      });
    };

    type Row = Record<string, unknown>;
    const insert = (qr: QueryRunner, table: string, row: Row) => {
      const cols = Object.keys(row);
      return qr.query(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };
    /** A real journal to point a transfer at: a system-to-system journal, rolled back with the sandbox. */
    const journal = async (qr: QueryRunner): Promise<string> => {
      const [psp] = await qr.manager.query<{ id: string }[]>(
        `SELECT id::text FROM accounts WHERE kind = 'PSP_CLEARING' AND currency = 'IRR'`,
      );
      const [ops] = await qr.manager.query<{ id: string }[]>(
        `SELECT id::text FROM accounts WHERE kind = 'OPS_ADJUSTMENTS' AND currency = 'IRR'`,
      );
      const [j] = await qr.manager.query<{ id: string }[]>(
        `INSERT INTO journals (kind, ref_type, ref_id, currency) VALUES ('TRANSFER', 'TRANSFER', $1, 'IRR') RETURNING id::text`,
        [randomUUID()],
      );
      for (const [account, amount] of [
        [psp.id, '-5'],
        [ops.id, '5'],
      ]) {
        await qr.query(
          `INSERT INTO postings (journal_id, account_id, account_kind, currency, amount_minor, balance_after_minor)
         SELECT $1, a.id, a.kind, a.currency, $3, a.balance_minor + $3::bigint FROM accounts a WHERE a.id = $2`,
          [j.id, account, amount],
        );
      }
      return j.id;
    };
    const transfer = (journalId: string, over: Row = {}): Row => ({
      id: randomUUID(),
      from_user_id: 'alice',
      to_user_id: 'bob',
      currency: 'IRR',
      amount_minor: '100',
      journal_id: journalId,
      ...over,
    });

    describe('transfers', () => {
      it('accepts a valid transfer and reads it back', async () => {
        await sandbox(async (qr) => {
          const j = await journal(qr);
          await insert(qr, 'transfers', transfer(j));
          const [r] = await qr.manager.query<{ n: string }[]>(
            `SELECT count(*)::text AS n FROM transfers WHERE journal_id = $1`,
            [j],
          );
          expect(r.n).toBe('1');
        });
      });

      it.each<[string, Row, string]>([
        ['a transfer to oneself', { to_user_id: 'alice' }, CHECK_VIOLATION],
        ['a zero amount', { amount_minor: '0' }, CHECK_VIOLATION],
        ['a negative amount', { amount_minor: '-5' }, CHECK_VIOLATION],
        ['an unknown currency', { currency: 'EUR' }, CHECK_VIOLATION],
        ['a sender id with a space', { from_user_id: 'a b' }, CHECK_VIOLATION],
        ['an empty receiver id', { to_user_id: '' }, CHECK_VIOLATION],
        [
          'a receiver id longer than 64 characters',
          { to_user_id: 'x'.repeat(65) },
          CHECK_VIOLATION,
        ],
        [
          'a journal that does not exist',
          { journal_id: '9223372036854775000' },
          FOREIGN_KEY_VIOLATION,
        ],
      ])('refuses %s', async (_c, over, expected) => {
        await refused(async (qr) => {
          const j = await journal(qr);
          await insert(qr, 'transfers', transfer(j, over));
        }, expected);
      });

      it('refuses two transfers on one journal', async () => {
        await refused(async (qr) => {
          const j = await journal(qr);
          await insert(qr, 'transfers', transfer(j));
          await insert(qr, 'transfers', transfer(j));
        }, UNIQUE_VIOLATION);
      });

      it('has the history indexes', async () => {
        const rows = await ds.query<{ indexdef: string }[]>(
          `SELECT indexdef FROM pg_indexes WHERE tablename = 'transfers'`,
        );
        const defs = rows.map((r) => r.indexdef).join('\n');
        expect(defs).toContain('(from_user_id, created_at DESC)');
        expect(defs).toContain('(to_user_id, created_at DESC)');
      });
    });

    describe('inbox', () => {
      it('is keyed by consumer and message id', async () => {
        await refused(async (qr) => {
          await insert(qr, 'inbox', { consumer: 'c', message_id: 'm' });
          await insert(qr, 'inbox', { consumer: 'c', message_id: 'm' });
        }, UNIQUE_VIOLATION);
        await sandbox(async (qr) => {
          await insert(qr, 'inbox', { consumer: 'c', message_id: 'm' });
          await insert(qr, 'inbox', { consumer: 'd', message_id: 'm' });
        });
      });

      it.each<[string, Row]>([
        ['an empty consumer', { consumer: '', message_id: 'm' }],
        ['an empty message id', { consumer: 'c', message_id: '' }],
      ])('refuses %s', async (_c, row) => {
        await refused((qr) => insert(qr, 'inbox', row), CHECK_VIOLATION);
      });
    });

    describe('notifications', () => {
      const note = (over: Row = {}): Row => ({
        message_id: randomUUID(),
        user_id: 'alice',
        kind: 'BALANCE_CHANGED',
        currency: 'IRR',
        journal_id: '1',
        available_minor: '0',
        frozen_minor: '0',
        debt_minor: '0',
        ...over,
      });

      it('accepts a notification, and refuses a second for the same message', async () => {
        await sandbox((qr) => insert(qr, 'notifications', note()));
        await refused(async (qr) => {
          const row = note();
          await insert(qr, 'notifications', row);
          await insert(qr, 'notifications', row);
        }, UNIQUE_VIOLATION);
      });

      it.each<[string, Row]>([
        ['an unknown kind', { kind: 'OTHER' }],
        ['an unknown currency', { currency: 'EUR' }],
      ])('refuses %s', async (_c, over) => {
        await refused(
          (qr) => insert(qr, 'notifications', note(over)),
          CHECK_VIOLATION,
        );
      });
    });

    it('the outbox has the partial indexes the relay and the purge walk', async () => {
      const rows = await ds.query<{ indexdef: string }[]>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'outbox'`,
      );
      const defs = rows.map((r) => r.indexdef).join('\n');
      expect(defs).toContain('WHERE (published_at IS NULL)');
      expect(defs).toContain('(published_at) WHERE (published_at IS NOT NULL)');
    });
  },
);
