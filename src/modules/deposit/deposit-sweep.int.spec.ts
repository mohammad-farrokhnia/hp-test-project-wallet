import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Money } from '../../common/money';
import { AppConfig, loadConfig } from '../../config/app-config';
import {
  connectTestDb,
  describeDb,
  lockDueWork,
} from '../../database/int-testing';
import { TransactionRunner, Tx } from '../../database/transaction-runner';
import { newIdempotencyService } from '../idempotency/testing';
import { HttpPspClient } from '../integrations/psp/http-psp.client';
import {
  FakePspServer,
  PspCreateFault,
} from '../integrations/psp/testing/fake-psp-server';
import { DepositDueWork } from './deposit.due-work';
import { DepositService } from './deposit.service';
import { DepositWatchdog } from './deposit.watchdog';
import { DepositsRepository } from './repositories/deposits.repository';

const ALL = 100_000;

class Rollback extends Error {}

describeDb('deposit sweeper sources (real PostgreSQL)', () => {
  let ds: DataSource;
  let unlockDueWork: (() => Promise<void>) | undefined;
  let runner: TransactionRunner;
  let service: DepositService;
  let config: AppConfig;
  let watchdog: DepositWatchdog;
  let error: jest.SpyInstance<
    void,
    [message: unknown, ...optionalParams: unknown[]]
  >;
  const dueWork = new DepositDueWork();
  const fake = new FakePspServer();
  let fault: PspCreateFault = 'ok';

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    ds = await connectTestDb();
    unlockDueWork = await lockDueWork(ds);
    fake.script = { onCreate: () => fault, verify503: () => false };
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 20_000,
    });
    config = loadConfig();
    watchdog = new DepositWatchdog(config);
    service = new DepositService(
      runner,
      newIdempotencyService(),
      new DepositsRepository(),
      new HttpPspClient(await fake.start(), 1000),
      config,
    );
  }, 180_000);

  afterAll(async () => {
    await unlockDueWork?.();
    await fake.stop();
    if (ds?.isInitialized) await ds.destroy();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    fault = 'ok';
    error.mockClear();
  });

  /**
   * Runs `fn` in a transaction that is always rolled back: the sources act on every row in the shared test database,
   * and this way they leave other suites' deposits as they were.
   */
  async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    let out!: T;
    try {
      await ds.transaction(async (tx) => {
        out = await fn(tx);
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    return out;
  }

  const request = (userId = `sw_${randomUUID().slice(0, 12)}`) => ({
    cmd: {
      userId,
      amount: Money.toman(1000n),
      body: { userId, amount: '1000' },
    },
    key: `sw-${randomUUID()}`,
    userId,
  });
  async function idOf(userId: string): Promise<string> {
    const [r] = await ds.query<{ id: string }[]>(
      'SELECT id FROM deposits WHERE user_id = $1',
      [userId],
    );
    return r.id;
  }
  async function pending(): Promise<string> {
    fault = 'ok';
    const r = request();
    await service.create(r.cmd, r.key);
    return idOf(r.userId);
  }
  async function created(): Promise<
    ReturnType<typeof request> & { id: string }
  > {
    fault = '503';
    const r = request();
    await expect(service.create(r.cmd, r.key)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    return { ...r, id: await idOf(r.userId) };
  }
  const setDb = (id: string, set: string) =>
    ds.query(`UPDATE deposits SET ${set} WHERE id = $1`, [id]);
  const row = async (tx: Tx, id: string) =>
    (
      await tx.query<
        {
          status: string;
          failure_reason: string | null;
          needs_review: boolean;
          review_reason: string | null;
          completed: boolean;
          next_in: number | null;
        }[]
      >(
        `SELECT status, failure_reason, needs_review, review_reason,
                completed_at IS NOT NULL AS completed,
                extract(epoch FROM next_check_at - now())::float AS next_in
           FROM deposits WHERE id = $1`,
        [id],
      )
    )[0];

  describe('DepositDueWork: the poller behind a lost callback (PSP-05)', () => {
    it('turns a due PENDING deposit into one sync job, and bumps it so it is not queued twice', async () => {
      const id = await pending();
      await setDb(id, `next_check_at = now() - interval '1 second'`);

      await rolledBack(async (tx) => {
        const jobs = await dueWork.claimDue(tx, ALL, 60);
        expect(jobs.filter((j) => j.aggregateId === id)).toEqual([
          {
            job: 'job.deposit.sync',
            aggregateType: 'DEPOSIT',
            aggregateId: id,
            payload: { depositId: id },
          },
        ]);
        const bumped = (await row(tx, id)).next_in as number;
        expect(bumped).toBeGreaterThan(55);
        expect(bumped).toBeLessThanOrEqual(60);

        const again = await dueWork.claimDue(tx, ALL, 60);
        expect(again.some((j) => j.aggregateId === id)).toBe(false);
      });
    });

    it('leaves a deposit alone until its next check is due', async () => {
      const id = await pending();
      await setDb(id, `next_check_at = now() + interval '1 minute'`);
      await rolledBack(async (tx) => {
        const jobs = await dueWork.claimDue(tx, ALL, 60);
        expect(jobs.some((j) => j.aggregateId === id)).toBe(false);
      });
    });

    it('never queues a deposit that is not PENDING', async () => {
      const done = await pending();
      await setDb(
        done,
        `status = 'FAILED', failure_reason = 'PSP_FAILED', completed_at = now(), next_check_at = now() - interval '1 minute'`,
      );
      const open = await created();
      await setDb(open.id, `next_check_at = now() - interval '1 minute'`);
      await rolledBack(async (tx) => {
        const ids = (await dueWork.claimDue(tx, ALL, 60)).map(
          (j) => j.aggregateId,
        );
        expect(ids).not.toContain(done);
        expect(ids).not.toContain(open.id);
      });
    });

    it('two sweepers at once never claim the same deposit', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const id = await pending();
        await setDb(id, `next_check_at = now() - interval '1 second'`);
        ids.push(id);
      }
      let claimed = 0;
      let release!: () => void;
      const bothClaimed = new Promise<void>((r) => (release = r));
      const sweeper = () =>
        rolledBack(async (tx) => {
          const got = (await dueWork.claimDue(tx, ALL, 60))
            .map((j) => j.aggregateId)
            .filter((id) => ids.includes(id));
          if (++claimed === 2) release();
          await bothClaimed;
          return got;
        });

      const [a, b] = await Promise.all([sweeper(), sweeper()]);

      expect(a.filter((id) => b.includes(id))).toEqual([]);
      expect([...a, ...b].sort()).toEqual([...ids].sort());
    });
  });

  describe('DepositWatchdog: abandoned creates', () => {
    it('fails a deposit still CREATED after 10 minutes, and leaves younger ones and other statuses alone', async () => {
      const old = await created();
      const young = await created();
      const issued = await pending();
      await setDb(old.id, `created_at = now() - interval '11 minutes'`);
      await setDb(young.id, `created_at = now() - interval '5 minutes'`);
      await setDb(issued, `created_at = now() - interval '11 minutes'`);

      await rolledBack(async (tx) => {
        expect(await watchdog.claimDue(tx, ALL)).toEqual([]);
        expect(await row(tx, old.id)).toMatchObject({
          status: 'FAILED',
          failure_reason: 'CREATE_ABANDONED',
          completed: true,
          next_in: null,
        });
        expect(await row(tx, young.id)).toMatchObject({ status: 'CREATED' });
        expect(await row(tx, issued)).toMatchObject({ status: 'PENDING' });
      });
    });

    it('a retry with the same key afterwards answers from the failed deposit, with no new PSP payment', async () => {
      const r = await created();
      await setDb(r.id, `created_at = now() - interval '11 minutes'`);
      await runner.run((tx) => watchdog.claimDue(tx, ALL));
      const before = fake.creates;
      fault = 'ok';

      const reply = await service.create(r.cmd, r.key);

      expect(reply.response).toEqual({
        status: 201,
        body: { depositId: r.id, status: 'FAILED', paymentUrl: null },
      });
      expect(fake.creates).toBe(before);
      const again = await service.create(r.cmd, r.key);
      expect(again).toMatchObject({ replayed: true, response: reply.response });
    });
  });

  describe('DepositWatchdog: paid but not verified for 2 minutes (D13, PSP-10)', () => {
    it('flags and alerts once, and never fails or reschedules the deposit', async () => {
      const slow = await pending();
      const fresh = await pending();
      const flagged = await pending();
      await setDb(slow, `paid_seen_at = now() - interval '3 minutes'`);
      await setDb(fresh, `paid_seen_at = now() - interval '1 minute'`);
      await setDb(
        flagged,
        `paid_seen_at = now() - interval '5 minutes', needs_review = true, review_reason = 'UNKNOWN_TOKEN'`,
      );

      await rolledBack(async (tx) => {
        const next = (await row(tx, slow)).next_in;
        expect(await watchdog.claimDue(tx, ALL)).toEqual([]);
        expect(await watchdog.claimDue(tx, ALL)).toEqual([]);

        expect(await row(tx, slow)).toMatchObject({
          status: 'PENDING',
          needs_review: true,
          review_reason: 'UNVERIFIED_TOO_LONG',
          failure_reason: null,
        });
        expect((await row(tx, slow)).next_in).toBeCloseTo(next as number, 0);
        expect(await row(tx, fresh)).toMatchObject({ needs_review: false });
        expect(await row(tx, flagged)).toMatchObject({
          review_reason: 'UNKNOWN_TOKEN',
        });
      });

      const alerts = error.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes(slow));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain('ALERT');
      expect(alerts[0]).toContain('UNVERIFIED_TOO_LONG');
    });

    it('does not touch a deposit that was never seen paid', async () => {
      const id = await pending();
      await rolledBack(async (tx) => {
        await watchdog.claimDue(tx, ALL);
        expect(await row(tx, id)).toMatchObject({ needs_review: false });
      });
    });
  });
});
