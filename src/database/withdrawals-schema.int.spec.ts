import { randomUUID } from 'node:crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { connectTestDb, describeDb } from './int-testing';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';

const IBAN = 'IR062960000000100324200001';
const TRC20 = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';

describeDb('withdrawal schema (real PostgreSQL)', () => {
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
    currency: 'IRR',
    amount_minor: '1000000',
    fee_minor: '0',
    destination_type: 'IBAN',
    destination: IBAN,
    status: 'PENDING',
    limit_day: '2026-11-04',
    limit_amount_rial: '1000000',
    ...over,
  });
  const insert = (qr: QueryRunner, row: Row) => {
    const cols = Object.keys(row);
    return qr.query(
      `INSERT INTO withdrawals (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };
  const final = { completed_at: '2026-11-04T10:00:00Z' };

  describe('withdrawals', () => {
    it.each<[string, Row]>([
      ['a pending IRR withdrawal to an IBAN', {}],
      [
        'a USDT withdrawal to TRC20 with its fee and limit rate',
        {
          currency: 'USDT',
          amount_minor: '10000000',
          fee_minor: '1000000',
          destination_type: 'TRC20',
          destination: TRC20,
          limit_rate_rial_per_usdt: '1000000',
        },
      ],
      [
        'a failed one with its reason',
        { status: 'FAILED', failure_reason: 'PROVIDER_FAILED', ...final },
      ],
      [
        'a succeeded one that was returned, then flagged',
        {
          status: 'SUCCEEDED',
          ...final,
          returned_at: '2026-11-05T10:00:00Z',
          return_reason: 'ACCOUNT_CLOSED',
          needs_review: true,
          review_reason: 'LATE_SUCCESS',
          late_success_at: '2026-11-04T11:00:00Z',
        },
      ],
    ])('accepts %s', async (_case, over) => {
      await sandbox(async (qr) => {
        await expect(insert(qr, valid(over))).resolves.toBeDefined();
      });
    });

    it.each<[string, Row, string]>([
      ['a zero amount', { amount_minor: '0' }, CHECK_VIOLATION],
      ['a negative fee', { fee_minor: '-1' }, CHECK_VIOLATION],
      ['an unknown currency', { currency: 'EUR' }, CHECK_VIOLATION],
      ['a malformed userId', { user_id: 'not valid!' }, CHECK_VIOLATION],
      [
        'IRR to a TRC20 address',
        { destination_type: 'TRC20', destination: TRC20 },
        CHECK_VIOLATION,
      ],
      ['USDT to an IBAN', { currency: 'USDT' }, CHECK_VIOLATION],
      ['a malformed IBAN', { destination: 'IR06 2960 0000' }, CHECK_VIOLATION],
      [
        'a lowercase IBAN (not normalised)',
        { destination: IBAN.toLowerCase() },
        CHECK_VIOLATION,
      ],
      [
        'a malformed TRC20 address',
        {
          currency: 'USDT',
          destination_type: 'TRC20',
          destination: 'T0OIl' + TRC20.slice(5),
        },
        CHECK_VIOLATION,
      ],
      ['an unknown status', { status: 'CANCELLED' }, CHECK_VIOLATION],
      [
        'FAILED without a reason',
        { status: 'FAILED', ...final },
        CHECK_VIOLATION,
      ],
      [
        'a failure reason while not FAILED',
        { failure_reason: 'CANCELLED' },
        CHECK_VIOLATION,
      ],
      [
        'an unknown failure reason',
        { status: 'FAILED', failure_reason: 'OOPS', ...final },
        CHECK_VIOLATION,
      ],
      [
        'a final status without completed_at',
        { status: 'SUCCEEDED' },
        CHECK_VIOLATION,
      ],
      [
        'completed_at on a non-final status',
        { status: 'PROCESSING', ...final },
        CHECK_VIOLATION,
      ],
      [
        'returned while not SUCCEEDED',
        { returned_at: '2026-11-05T10:00:00Z' },
        CHECK_VIOLATION,
      ],
      [
        'a return reason without a return',
        { status: 'SUCCEEDED', ...final, return_reason: 'ACCOUNT_CLOSED' },
        CHECK_VIOLATION,
      ],
      [
        'a late success while not SUCCEEDED',
        { late_success_at: '2026-11-04T11:00:00Z' },
        CHECK_VIOLATION,
      ],
      [
        'needs_review without a reason',
        { needs_review: true },
        CHECK_VIOLATION,
      ],
      [
        'an unknown review reason',
        { needs_review: true, review_reason: 'BORED' },
        CHECK_VIOLATION,
      ],
      ['a negative limit amount', { limit_amount_rial: '-1' }, CHECK_VIOLATION],
      [
        'a limit rate on IRR',
        { limit_rate_rial_per_usdt: '1000000' },
        CHECK_VIOLATION,
      ],
      ['negative submit attempts', { submit_attempts: -1 }, CHECK_VIOLATION],
      ['no limit day', { limit_day: null }, NOT_NULL_VIOLATION],
    ])('refuses %s', async (_case, over, code) => {
      await sandbox(async (qr) => {
        await expect(insert(qr, valid(over))).rejects.toMatchObject({
          driverError: { code },
        });
      });
    });

    it('refuses a second withdrawal with the same id (the payout requestId)', async () => {
      await sandbox(async (qr) => {
        const row = valid();
        await insert(qr, row);
        await expect(insert(qr, valid({ id: row.id }))).rejects.toMatchObject({
          driverError: { code: UNIQUE_VIOLATION },
        });
      });
    });

    it('refreshes updated_at on every change', async () => {
      await sandbox(async (qr) => {
        const row = valid({ updated_at: '2000-01-01T00:00:00Z' });
        await insert(qr, row);
        const [[updated]] = await qr.manager.query<
          [{ moved: boolean }[], number]
        >(
          `UPDATE withdrawals SET status = 'SUBMITTING' WHERE id = $1
           RETURNING updated_at > '2000-01-02' AS moved`,
          [row.id],
        );
        expect(updated.moved).toBe(true);
      });
    });
  });

  describe('payout_attempts', () => {
    const attempt = (
      qr: QueryRunner,
      withdrawalId: unknown,
      over: Row = {},
    ) => {
      const row: Row = {
        withdrawal_id: withdrawalId,
        attempt_no: 1,
        request_body: '{}',
        ...over,
      };
      const cols = Object.keys(row);
      return qr.query(
        `INSERT INTO payout_attempts (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };

    it('accepts an attempt in flight and a finished one', async () => {
      await sandbox(async (qr) => {
        const w = valid();
        await insert(qr, w);
        await attempt(qr, w.id);
        await expect(
          attempt(qr, w.id, {
            attempt_no: 2,
            finished_at: '2026-11-04T10:00:00Z',
            outcome: 'AMBIGUOUS',
            error: 'timeout',
          }),
        ).resolves.toBeDefined();
      });
    });

    it.each<[string, Row, string]>([
      ['attempt 0', { attempt_no: 0 }, CHECK_VIOLATION],
      [
        'an outcome without finished_at',
        { outcome: 'ACCEPTED' },
        CHECK_VIOLATION,
      ],
      [
        'finished_at without an outcome',
        { finished_at: '2026-11-04T10:00:00Z' },
        CHECK_VIOLATION,
      ],
      [
        'an unknown outcome',
        { outcome: 'MAYBE', finished_at: '2026-11-04T10:00:00Z' },
        CHECK_VIOLATION,
      ],
      ['an impossible HTTP status', { http_status: 42 }, CHECK_VIOLATION],
    ])('refuses %s', async (_case, over, code) => {
      await sandbox(async (qr) => {
        const w = valid();
        await insert(qr, w);
        await expect(attempt(qr, w.id, over)).rejects.toMatchObject({
          driverError: { code },
        });
      });
    });

    it('refuses the same attempt number twice, and an attempt for no withdrawal', async () => {
      await sandbox(async (qr) => {
        const w = valid();
        await insert(qr, w);
        await attempt(qr, w.id);
        await expect(attempt(qr, w.id)).rejects.toMatchObject({
          driverError: { code: UNIQUE_VIOLATION },
        });
      });
      await sandbox(async (qr) => {
        await expect(attempt(qr, randomUUID())).rejects.toMatchObject({
          driverError: { code: FOREIGN_KEY_VIOLATION },
        });
      });
    });
  });

  describe('withdrawal_daily_usage', () => {
    const usage = (qr: QueryRunner, used: string, cap = '2000000000') =>
      qr.query(
        `INSERT INTO withdrawal_daily_usage (user_id, day, used_rial, cap_rial) VALUES ('alice', '2026-11-04', $1, $2)`,
        [used, cap],
      );

    it('accepts usage up to the cap, inclusive', async () => {
      await sandbox(async (qr) => {
        await expect(usage(qr, '2000000000')).resolves.toBeDefined();
      });
    });

    it.each([
      ['usage above the cap', '2000000001', '2000000000'],
      ['negative usage', '-1', '2000000000'],
      ['a zero cap', '0', '0'],
    ])('refuses %s', async (_case, used, cap) => {
      await sandbox(async (qr) => {
        await expect(usage(qr, used, cap)).rejects.toMatchObject({
          driverError: { code: CHECK_VIOLATION },
        });
      });
    });

    it('refuses pushing usage past the cap with an UPDATE too', async () => {
      await sandbox(async (qr) => {
        await usage(qr, '1999999999');
        await expect(
          qr.query(
            `UPDATE withdrawal_daily_usage SET used_rial = used_rial + 2
              WHERE user_id = 'alice' AND day = '2026-11-04'`,
          ),
        ).rejects.toMatchObject({ driverError: { code: CHECK_VIOLATION } });
      });
    });
  });
});
