import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { Money } from '../../common/money';
import { loadConfig } from '../../config/app-config';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { TransactionRunner } from '../../database/transaction-runner';
import { newIdempotencyService } from '../idempotency/testing';
import { HttpPspClient } from '../integrations/psp/http-psp.client';
import { newLedgerService } from '../ledger/testing';
import { DepositService } from './deposit.service';
import { DepositSyncHandler } from './handlers/deposit-sync.handler';
import { DepositLifecycleRepository } from './repositories/deposit-lifecycle.repository';
import { DepositsRepository } from './repositories/deposits.repository';

const simulator = process.env.SMOKE_PSP_URL?.replace(/\/$/, '');
const smoke = simulator ? describeDb : describe.skip;

const TIMEOUT_MS = 120_000;
const TRIES = 20;

/**
 * Smoke run against the real `hamtapay/t103-simulator:1.0`, off by default. The simulator's callbacks go nowhere here
 * (the callback URL is not reachable), so every payment is a "lost callback" and the sync finds it by polling alone.
 *
 * Run it with `SIM_CHAOS=off` and with `hostile`: in hostile mode creates and verifies answer 503 now and then, and the test must still end credited.
 */
smoke(`deposit against the real simulator ${simulator ?? ''}`, () => {
  let ds: DataSource;
  let service: DepositService;
  let handler: DepositSyncHandler;

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation();
    }
    ds = await connectTestDb();
    const runner = new TransactionRunner(ds, {
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 20_000,
    });
    const psp = new HttpPspClient(simulator as string, 5000);
    service = new DepositService(
      runner,
      newIdempotencyService(),
      new DepositsRepository(),
      psp,
      loadConfig(),
    );
    handler = new DepositSyncHandler(
      runner,
      new DepositLifecycleRepository(),
      newLedgerService(),
      psp,
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    jest.restoreAllMocks();
  });

  /** Creates a 1,000 toman deposit, retrying the same key through the simulator's 503s as a client would. */
  async function open(): Promise<{ id: string; token: string }> {
    const userId = `smoke_${randomUUID().slice(0, 12)}`;
    const key = `smoke-${randomUUID()}`;
    const cmd = {
      userId,
      amount: Money.toman(1000n),
      body: { userId, amount: '1000' },
    };
    for (let i = 0; i < TRIES; i++) {
      try {
        const { response } = await service.create(cmd, key);
        const id = (response.body as { depositId: string }).depositId;
        const [{ psp_token: token }] = await ds.query<{ psp_token: string }[]>(
          'SELECT psp_token FROM deposits WHERE id = $1',
          [id],
        );
        return { id, token };
      } catch (e) {
        if ((e as { code?: string }).code !== 'PROVIDER_UNAVAILABLE') throw e;
        await sleep(500);
      }
    }
    throw new Error('the simulator never accepted the create');
  }

  const sync = (id: string) =>
    handler.handle({
      messageId: randomUUID(),
      type: 'job.deposit.sync',
      aggregateType: 'DEPOSIT',
      aggregateId: id,
      occurredAt: new Date().toISOString(),
      payload: { depositId: id },
    });
  const status = async (id: string) =>
    (
      await ds.query<{ status: string; credited_rial: string | null }[]>(
        'SELECT status, credited_rial::text FROM deposits WHERE id = $1',
        [id],
      )
    )[0];

  it(
    'an unpaid deposit stays PENDING however often it is synced (-51 while INIT)',
    async () => {
      const d = await open();
      for (let i = 0; i < 3; i++) {
        await sync(d.id);
        expect(await status(d.id)).toEqual({
          status: 'PENDING',
          credited_rial: null,
        });
      }
    },
    TIMEOUT_MS,
  );

  it(
    'a paid deposit is credited its verified amount by polling alone, whatever the 503s',
    async () => {
      const d = await open();
      const paid = await fetch(`${simulator}/psp/pay/${d.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ result: 'success' }),
      });
      expect(paid.status).toBe(200);

      let last = await status(d.id);
      for (let i = 0; i < TRIES && last.status === 'PENDING'; i++) {
        await sync(d.id);
        last = await status(d.id);
        if (last.status === 'PENDING') await sleep(1000);
      }

      expect(last).toEqual({ status: 'SUCCEEDED', credited_rial: '10000' });
      await sync(d.id);
      expect(await status(d.id)).toEqual(last);
    },
    TIMEOUT_MS,
  );
});
