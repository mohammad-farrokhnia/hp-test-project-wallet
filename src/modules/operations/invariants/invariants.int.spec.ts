import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Money } from '../../../common/money';
import { connectTestDb, describeDb } from '../../../database/int-testing';
import { Tx, TransactionRunner } from '../../../database/transaction-runner';
import { InvariantName, UserAccountIds } from '../../ledger';
import { newLedgerService } from '../../ledger/testing';
import { InvariantsReport, InvariantsService } from './invariants.service';
import {
  NoOpenWithdrawals,
  OpenWithdrawalTotal,
  OpenWithdrawalTotals,
} from './open-withdrawal-totals';

describeDb('InvariantsService (real PostgreSQL)', () => {
  let ds: DataSource;
  let runner: TransactionRunner;
  const ledger = newLedgerService();
  const service = (totals: OpenWithdrawalTotals = new NoOpenWithdrawals()) =>
    new InvariantsService(runner, ledger, totals);

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

  /** Runs `fn` in a transaction that is always rolled back: broken books never reach other suites. */
  async function sandbox(fn: (tx: Tx) => Promise<void>): Promise<void> {
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SET LOCAL lock_timeout = '10s'`);
      await fn(qr.manager);
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  }

  /**
   * A fresh user credited `rial` through the ledger, the normal way.
   * `idPrefix` matters when the report is truncated: violations are sorted by user id and cut at the limit, so a test that must see its own row uses a prefix that sorts before every user other suites left committed.
   */
  async function fundedUser(tx: Tx, rial = 100n, idPrefix = 'l4_') {
    const userId = `${idPrefix}${randomUUID().slice(0, 12)}`;
    const ids = await ledger.ensureUserAccounts(tx, userId, 'IRR');
    const ops = await ledger.systemAccountId(tx, 'OPS_ADJUSTMENTS', 'IRR');
    await ledger.post(tx, {
      kind: 'ADJUSTMENT_CREDIT',
      refId: randomUUID(),
      currency: 'IRR',
      lines: [
        { accountId: ops, amount: Money.rial(-rial) },
        { accountId: ids.available, amount: Money.rial(rial) },
      ],
    });
    return { userId, ids };
  }

  const freeze = (tx: Tx, ids: UserAccountIds, rial: bigint) =>
    ledger.post(tx, {
      kind: 'WITHDRAWAL_FREEZE',
      refId: randomUUID(),
      currency: 'IRR',
      lines: [
        { accountId: ids.available, amount: Money.rial(-rial) },
        { accountId: ids.frozen, amount: Money.rial(rial) },
      ],
    });

  /** Violations of one check that mention `id` (a user or account id): other suites' data is ignored. */
  const violations = (r: InvariantsReport, name: InvariantName, id: string) =>
    r.checks
      .find((c) => c.name === name)!
      .violations.filter((v) => Object.values(v).includes(id));

  it('reports every check, read-only, on the committed books', async () => {
    const report = await service().check();
    expect(report.checks.map((c) => c.name)).toEqual([
      'ZERO_SUM',
      'BALANCE_EQUALS_POSTINGS',
      'NO_NEGATIVE_BALANCES',
      'AVAILABLE_ONLY_WITHOUT_DEBT',
      'FROZEN_EQUALS_OPEN_WITHDRAWALS',
    ]);
    expect(report.ok).toBe(report.checks.every((c) => c.ok));
  });

  it('finds nothing wrong with books written through the ledger', async () => {
    await sandbox(async (tx) => {
      const { userId, ids } = await fundedUser(tx, 1_000n);
      await freeze(tx, ids, 400n);
      const open: OpenWithdrawalTotal[] = [
        { userId, amount: Money.rial(400n) },
      ];
      const report = await service({
        openTotals: () => Promise.resolve(open),
      }).checkIn(tx);

      for (const check of report.checks) {
        for (const id of [userId, ids.available.toString()]) {
          expect(violations(report, check.name, id)).toEqual([]);
        }
      }
    });
  });

  it('ZERO_SUM: reports a journal whose postings do not sum to zero', async () => {
    await sandbox(async (tx) => {
      const { userId, ids } = await fundedUser(tx);
      // The deferred trigger would refuse this at commit; the sandbox never commits.
      const [{ id }] = await tx.query<{ id: string }[]>(
        `INSERT INTO journals (kind, ref_type, ref_id, currency)
         VALUES ('TRANSFER', 'TRANSFER', $1, 'IRR') RETURNING id::text`,
        [randomUUID()],
      );
      await tx.query(
        `INSERT INTO postings (journal_id, account_id, user_id, account_kind, currency, amount_minor, balance_after_minor)
         VALUES ($1, $2, $3, 'AVAILABLE', 'IRR', 5, 105)`,
        [id, ids.available.toString(), userId],
      );

      const report = await service().checkIn(tx);
      expect(violations(report, 'ZERO_SUM', id)).toEqual([
        expect.objectContaining({ sum_minor: '5', postings: '1' }),
      ]);
      expect(report.ok).toBe(false);
    });
  });

  it('BALANCE_EQUALS_POSTINGS: reports a balance changed without a posting', async () => {
    await sandbox(async (tx) => {
      const { ids } = await fundedUser(tx, 100n);
      await tx.query('UPDATE accounts SET balance_minor = 90 WHERE id = $1', [
        ids.available.toString(),
      ]);

      const report = await service().checkIn(tx);
      expect(
        violations(report, 'BALANCE_EQUALS_POSTINGS', ids.available.toString()),
      ).toEqual([
        expect.objectContaining({
          balance_minor: '90',
          postings_sum_minor: '100',
          last_balance_after_minor: '100',
        }),
      ]);
    });
  });

  it('BALANCE_EQUALS_POSTINGS: reports a wrong balance_after even when the sum is right', async () => {
    await sandbox(async (tx) => {
      const { userId, ids } = await fundedUser(tx, 100n);
      const [{ id }] = await tx.query<{ id: string }[]>(
        `INSERT INTO journals (kind, ref_type, ref_id, currency)
         VALUES ('WITHDRAWAL_FREEZE', 'WITHDRAWAL', $1, 'IRR') RETURNING id::text`,
        [randomUUID()],
      );
      await tx.query(
        `INSERT INTO postings (journal_id, account_id, user_id, account_kind, currency, amount_minor, balance_after_minor)
         VALUES ($1, $2, $4, 'AVAILABLE', 'IRR', -7, 999),
                ($1, $3, $4, 'FROZEN', 'IRR', 7, 7)`,
        [id, ids.available.toString(), ids.frozen.toString(), userId],
      );
      await tx.query(
        `UPDATE accounts SET balance_minor = CASE id WHEN $1::bigint THEN 93 ELSE 7 END
          WHERE id IN ($1::bigint, $2::bigint)`,
        [ids.available.toString(), ids.frozen.toString()],
      );

      const report = await service().checkIn(tx);
      expect(
        violations(report, 'BALANCE_EQUALS_POSTINGS', ids.available.toString()),
      ).toEqual([
        expect.objectContaining({
          balance_minor: '93',
          postings_sum_minor: '93',
          last_balance_after_minor: '999',
        }),
      ]);
    });
  });

  it('NO_NEGATIVE_BALANCES: reports a protected balance below zero and DEBT above zero', async () => {
    await sandbox(async (tx) => {
      // The CHECKs make this impossible, so drop them first (rolled back with the sandbox).
      await tx.query(
        'ALTER TABLE accounts DROP CONSTRAINT accounts_no_overdraft, DROP CONSTRAINT accounts_debt_not_positive',
      );
      const { ids } = await fundedUser(tx);
      await tx.query(
        `UPDATE accounts SET balance_minor = CASE id WHEN $1::bigint THEN -1 ELSE 3 END
          WHERE id IN ($1::bigint, $2::bigint)`,
        [ids.available.toString(), ids.debt.toString()],
      );

      const report = await service().checkIn(tx);
      expect(
        violations(report, 'NO_NEGATIVE_BALANCES', ids.available.toString()),
      ).toEqual([expect.objectContaining({ balance_minor: '-1' })]);
      expect(
        violations(report, 'NO_NEGATIVE_BALANCES', ids.debt.toString()),
      ).toEqual([
        expect.objectContaining({ kind: 'DEBT', balance_minor: '3' }),
      ]);
    });
  });

  it('AVAILABLE_ONLY_WITHOUT_DEBT: reports AVAILABLE money held while in DEBT', async () => {
    await sandbox(async (tx) => {
      const { userId, ids } = await fundedUser(tx, 100n);
      await tx.query('UPDATE accounts SET balance_minor = -5 WHERE id = $1', [
        ids.debt.toString(),
      ]);

      const report = await service().checkIn(tx);
      expect(violations(report, 'AVAILABLE_ONLY_WITHOUT_DEBT', userId)).toEqual(
        [expect.objectContaining({ available_minor: '100', debt_minor: '-5' })],
      );
    });
  });

  it('FROZEN_EQUALS_OPEN_WITHDRAWALS: reports frozen money no open withdrawal explains', async () => {
    await sandbox(async (tx) => {
      const { userId, ids } = await fundedUser(tx, 100n, '00_');
      await freeze(tx, ids, 40n);

      const report = await service().checkIn(tx);
      expect(
        violations(report, 'FROZEN_EQUALS_OPEN_WITHDRAWALS', userId),
      ).toEqual([
        {
          user_id: userId,
          currency: 'IRR',
          frozen_minor: '40',
          open_withdrawals_minor: '0',
        },
      ]);
    });
  });
});
