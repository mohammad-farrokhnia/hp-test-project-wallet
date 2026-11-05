import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Money } from '../../../common/money';
import { connectTestDb, describeDb } from '../../../database/int-testing';
import { Tx, TransactionRunner } from '../../../database/transaction-runner';
import { newLedgerService } from '../../ledger/testing';
import { OutboxMessage, OutboxService } from './outbox.service';

describeDb('OutboxService (real PostgreSQL)', () => {
  let ds: DataSource;
  let runner: TransactionRunner;
  const outbox = new OutboxService();
  const ledger = newLedgerService();

  beforeAll(async () => {
    ds = await connectTestDb();
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 5000,
      statementTimeoutMs: 10_000,
    });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const job = (withdrawalId: string): OutboxMessage => ({
    exchange: 'wallet.jobs',
    routingKey: 'job.withdrawal.submit',
    aggregate: { type: 'WITHDRAWAL', id: withdrawalId },
    payload: { withdrawalId },
  });
  const rowsFor = (aggregateId: string) =>
    ds.query<Record<string, unknown>[]>(
      'SELECT * FROM outbox WHERE aggregate_id = $1',
      [aggregateId],
    );
  /** A business change in the same transaction: a credit through the ledger. */
  const businessChange = (tx: Tx, refId: string) =>
    ledger.creditUser(tx, {
      userId: `m1_${refId.slice(0, 12)}`,
      amount: Money.rial(100n),
      source: 'OPS_ADJUSTMENTS',
      kind: 'ADJUSTMENT_CREDIT',
      refId,
    });
  const journalsFor = async (refId: string) => {
    const [{ n }] = await ds.query<{ n: string }[]>(
      'SELECT count(*)::text AS n FROM journals WHERE ref_id = $1',
      [refId],
    );
    return n;
  };

  it('a committed business transaction leaves exactly one unsent outbox row', async () => {
    const id = randomUUID();
    const outboxId = await runner.run(async (tx) => {
      await businessChange(tx, id);
      return outbox.add(tx, job(id));
    });

    const rows = await rowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: outboxId.toString(),
      exchange: 'wallet.jobs',
      routing_key: 'job.withdrawal.submit',
      aggregate_type: 'WITHDRAWAL',
      payload: { withdrawalId: id },
      published_at: null,
      claimed_until: null,
      attempts: 0,
    });
    expect(await journalsFor(id)).toBe('1');
  });

  it('a rolled-back business transaction leaves no outbox row, and no journal', async () => {
    const id = randomUUID();
    await expect(
      runner.run(async (tx) => {
        await businessChange(tx, id);
        await outbox.add(tx, job(id));
        throw new Error('business rule failed after the outbox write');
      }),
    ).rejects.toThrow('business rule failed');

    expect(await rowsFor(id)).toEqual([]);
    expect(await journalsFor(id)).toBe('0');
  });

  it('gives each message its own increasing id (the message id)', async () => {
    const id = randomUUID();
    const [a, b] = await runner.run(async (tx) => [
      await outbox.add(tx, job(id)),
      await outbox.add(tx, { ...job(id), routingKey: 'job.withdrawal.sync' }),
    ]);
    expect(b > a).toBe(true);
  });

  it('the database refuses an exchange outside the topology', async () => {
    await expect(
      runner.run((tx) =>
        outbox.add(tx, {
          ...job(randomUUID()),
          exchange: 'amq.direct' as OutboxMessage['exchange'],
        }),
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
  });
});
