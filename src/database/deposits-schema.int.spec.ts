import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { connectTestDb, describeDb } from './int-testing';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const NOT_NULL_VIOLATION = '23502';

describeDb('deposit schema (real PostgreSQL)', () => {
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

  type Row = Record<string, unknown>;
  const valid = (over: Row = {}): Row => ({
    id: randomUUID(),
    user_id: 'alice',
    amount_rial: '10000000',
    status: 'CREATED',
    expires_at: '2099-01-01T00:00:00Z',
    ...over,
  });
  const insert = (qr: QueryRunner, row: Row) => {
    const cols = Object.keys(row);
    return qr.query(
      `INSERT INTO deposits (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };
  const pending = {
    status: 'PENDING',
    psp_token: 'tok-1',
    payment_url: 'https://psp.test/pay/tok-1',
    psp_status: 'INIT',
  };
  const final = { completed_at: '2026-11-04T10:00:00Z' };

  it.each<[string, Row]>([
    ['a freshly created deposit', {}],
    ['a pending deposit with its token and link', pending],
    [
      'a succeeded deposit with the verified amount and bank reference',
      {
        ...pending,
        status: 'SUCCEEDED',
        credited_rial: '9999999',
        psp_ref_id: 'REF-1',
        psp_status: 'VERIFIED',
        ...final,
        needs_review: true,
        review_reason: 'AMOUNT_DIFFERS',
      },
    ],
    [
      'a failed deposit that never reached the PSP',
      {
        status: 'FAILED',
        failure_reason: 'CREATE_ABANDONED',
        ...final,
      },
    ],
    [
      'a failed deposit that expired unpaid',
      { ...pending, status: 'FAILED', failure_reason: 'EXPIRED', ...final },
    ],
    [
      'a pending deposit seen paid but unverified',
      {
        ...pending,
        psp_status: 'PAID',
        paid_seen_at: '2026-11-04T09:00:00Z',
        check_attempts: 3,
        next_check_at: '2026-11-04T09:01:00Z',
      },
    ],
  ])('accepts %s', async (_case, over) => {
    await sandbox(async (qr) => {
      await expect(insert(qr, valid(over))).resolves.toBeDefined();
    });
  });

  it.each<[string, Row, string]>([
    ['a zero amount', { amount_rial: '0' }, CHECK_VIOLATION],
    ['a negative amount', { amount_rial: '-1' }, CHECK_VIOLATION],
    ['a malformed userId', { user_id: 'not valid!' }, CHECK_VIOLATION],
    ['an unknown status', { status: 'REFUNDED' }, CHECK_VIOLATION],
    [
      'FAILED without a reason',
      { status: 'FAILED', ...final },
      CHECK_VIOLATION,
    ],
    [
      'a failure reason while not FAILED',
      { failure_reason: 'EXPIRED' },
      CHECK_VIOLATION,
    ],
    [
      'an unknown failure reason',
      { status: 'FAILED', failure_reason: 'OOPS', ...final },
      CHECK_VIOLATION,
    ],
    [
      'SUCCEEDED without a credited amount',
      { ...pending, status: 'SUCCEEDED', ...final },
      CHECK_VIOLATION,
    ],
    [
      'a credited amount while not SUCCEEDED',
      { ...pending, credited_rial: '1' },
      CHECK_VIOLATION,
    ],
    [
      'a zero credited amount',
      { ...pending, status: 'SUCCEEDED', credited_rial: '0', ...final },
      CHECK_VIOLATION,
    ],
    [
      'a final status without completed_at',
      { status: 'FAILED', failure_reason: 'PSP_FAILED' },
      CHECK_VIOLATION,
    ],
    [
      'completed_at on a non-final status',
      { ...pending, ...final },
      CHECK_VIOLATION,
    ],
    [
      'PENDING without a token',
      { status: 'PENDING', psp_status: 'INIT' },
      CHECK_VIOLATION,
    ],
    [
      'SUCCEEDED without a token',
      { status: 'SUCCEEDED', credited_rial: '1', ...final },
      CHECK_VIOLATION,
    ],
    ['an unknown PSP status', { psp_status: 'MAYBE' }, CHECK_VIOLATION],
    ['needs_review without a reason', { needs_review: true }, CHECK_VIOLATION],
    [
      'an unknown review reason',
      { needs_review: true, review_reason: 'BORED' },
      CHECK_VIOLATION,
    ],
    ['negative check attempts', { check_attempts: -1 }, CHECK_VIOLATION],
    [
      'an expiry before creation',
      {
        created_at: '2026-11-04T10:00:00Z',
        expires_at: '2026-11-04T09:00:00Z',
      },
      CHECK_VIOLATION,
    ],
    ['no expiry', { expires_at: null }, NOT_NULL_VIOLATION],
  ])('refuses %s', async (_case, over, code) => {
    await sandbox(async (qr) => {
      await expect(insert(qr, valid(over))).rejects.toMatchObject({
        driverError: { code },
      });
    });
  });

  describe('uniqueness', () => {
    it('refuses a second deposit with the same id (the PSP orderId)', async () => {
      await sandbox(async (qr) => {
        const row = valid();
        await insert(qr, row);
        await expect(insert(qr, valid({ id: row.id }))).rejects.toMatchObject({
          driverError: { code: UNIQUE_VIOLATION },
        });
      });
    });

    it('refuses one PSP token on two deposits', async () => {
      await sandbox(async (qr) => {
        await insert(qr, valid(pending));
        await expect(insert(qr, valid(pending))).rejects.toMatchObject({
          driverError: { code: UNIQUE_VIOLATION },
        });
      });
    });

    it('refuses one bank reference on two deposits', async () => {
      await sandbox(async (qr) => {
        const succeeded = {
          ...pending,
          status: 'SUCCEEDED',
          credited_rial: '1',
          psp_ref_id: 'REF-1',
          ...final,
        };
        await insert(qr, valid(succeeded));
        await expect(
          insert(qr, valid({ ...succeeded, psp_token: 'tok-2' })),
        ).rejects.toMatchObject({ driverError: { code: UNIQUE_VIOLATION } });
      });
    });

    it('allows many deposits with no token or reference yet', async () => {
      await sandbox(async (qr) => {
        await insert(qr, valid());
        await expect(insert(qr, valid())).resolves.toBeDefined();
      });
    });
  });

  describe('table behaviour', () => {
    it('refreshes updated_at on every change', async () => {
      await sandbox(async (qr) => {
        const row = valid({ updated_at: '2000-01-01T00:00:00Z' });
        await insert(qr, row);
        const [[updated]] = await qr.manager.query<
          [{ moved: boolean }[], number]
        >(
          `UPDATE deposits SET check_attempts = 1 WHERE id = $1
           RETURNING updated_at > '2000-01-02' AS moved`,
          [row.id],
        );
        expect(updated.moved).toBe(true);
      });
    });

    it('stores amounts beyond 2^53 without loss', async () => {
      await sandbox(async (qr) => {
        const row = valid({ amount_rial: '9223372036854775807' });
        await insert(qr, row);
        const [stored] = await qr.manager.query<{ amount: string }[]>(
          'SELECT amount_rial::text AS amount FROM deposits WHERE id = $1',
          [row.id],
        );
        expect(stored.amount).toBe('9223372036854775807');
      });
    });

    it('has the sweeper and history indexes', async () => {
      const rows = await ds.query<{ indexdef: string }[]>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'deposits'`,
      );
      const defs = rows.map((r) => r.indexdef).join('\n');
      expect(defs).toContain(
        '(next_check_at) WHERE (next_check_at IS NOT NULL)',
      );
      expect(defs).toContain('(user_id, created_at DESC)');
    });

    it('has the watchdog queues: abandoned creates and unverified payments', async () => {
      const rows = await ds.query<{ indexdef: string }[]>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'deposits'`,
      );
      const defs = rows.map((r) => r.indexdef).join('\n');
      expect(defs).toContain(`(created_at) WHERE (status = 'CREATED'::text)`);
      expect(defs).toContain('(paid_seen_at) WHERE');
      expect(defs).toContain('NOT needs_review');
    });
  });
});
