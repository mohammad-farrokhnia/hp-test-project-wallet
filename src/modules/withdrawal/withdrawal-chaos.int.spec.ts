import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Money } from '../../common/money';
import { AppConfig, loadConfig } from '../../config/app-config';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { TransactionRunner } from '../../database/transaction-runner';
import { newIdempotencyService } from '../idempotency/testing';
import { HttpPayoutClient } from '../integrations/payout/http-payout.client';
import {
  CreateFault,
  FakePayoutServer,
} from '../integrations/payout/testing/fake-payout-server';
import {
  LookupOutcome,
  PayoutClient,
  PayoutRequest,
  SubmitOutcome,
  TransferStatus,
} from '../integrations/payout';
import { newLedgerService } from '../ledger/testing';
import { Envelope, OutboxService } from '../messaging';
import { OutboxRepository } from '../messaging/outbox/outbox.repository';
import { InvariantsService } from '../operations/invariants/invariants.service';
import { buildPolicies } from './domain/withdrawal-policy';
import { WithdrawalSubmitHandler } from './handlers/withdrawal-submit.handler';
import { WithdrawalSyncHandler } from './handlers/withdrawal-sync.handler';
import { DailyLimitRepository } from './repositories/daily-limit.repository';
import { PayoutAttemptsRepository } from './repositories/payout-attempts.repository';
import { WithdrawalLifecycleRepository } from './repositories/withdrawal-lifecycle.repository';
import { WithdrawalsRepository } from './repositories/withdrawals.repository';
import { WithdrawalDueWork } from './withdrawal.due-work';
import { WithdrawalService } from './withdrawal.service';

const IBAN = 'IR330566736841214070501510';

/** The three withdrawal crash points of state-machines.md, "Crash at any point". */
type CrashPoint =
  | 'after-W1-before-call'
  | 'after-call-before-record'
  | 'after-success-before-settle';

class ProcessDied extends Error {
  constructor(point: CrashPoint) {
    super(`process died ${point}`);
  }
}

/**
 * The real adapter, except that the process "dies" once per withdrawal at a crash point: the
 * handler throws there, so whatever came after (recording, settling) never happens.
 */
class CrashingPayout implements PayoutClient {
  private readonly crashed = new Set<string>();
  constructor(
    private readonly real: PayoutClient,
    private readonly pointFor: (requestId: string) => CrashPoint | null,
  ) {}
  requestBody(r: PayoutRequest) {
    return this.real.requestBody(r);
  }
  async submit(r: PayoutRequest): Promise<SubmitOutcome> {
    const point = this.once(r.requestId, [
      'after-W1-before-call',
      'after-call-before-record',
    ]);
    if (point === 'after-W1-before-call') throw new ProcessDied(point);
    const outcome = await this.real.submit(r);
    if (point === 'after-call-before-record') throw new ProcessDied(point);
    return outcome;
  }
  async getTransfer(requestId: string): Promise<LookupOutcome> {
    const found = await this.real.getTransfer(requestId);
    const final =
      found.kind === 'FOUND' &&
      ['SUCCEEDED', 'RETURNED'].includes(found.snapshot.status);
    if (final && this.once(requestId, ['after-success-before-settle'])) {
      throw new ProcessDied('after-success-before-settle');
    }
    return found;
  }
  private once(id: string, at: CrashPoint[]): CrashPoint | null {
    const point = this.pointFor(id);
    if (!point || !at.includes(point) || this.crashed.has(id)) return null;
    this.crashed.add(id);
    return point;
  }
}

/** Deterministic randomness, so a failing chaos run can be replayed. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** After every crash, one transfer per requestId and no withdrawal left unknown. */
describeDb(
  'withdrawal crash and chaos tests (real PostgreSQL, fake payout server)',
  () => {
    let ds: DataSource;
    let runner: TransactionRunner;
    let config: AppConfig;
    let service: WithdrawalService;
    let server: FakePayoutServer;
    let real: HttpPayoutClient;
    const ledger = newLedgerService();
    const outbox = new OutboxService(new OutboxRepository());

    beforeAll(async () => {
      for (const level of ['log', 'warn', 'error'] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation();
      }
      ds = await connectTestDb();
      runner = new TransactionRunner(ds, {
        lockTimeoutMs: 10_000,
        statementTimeoutMs: 20_000,
      });
      config = loadConfig();
      service = new WithdrawalService(
        runner,
        newIdempotencyService(),
        ledger,
        outbox,
        new WithdrawalsRepository(),
        new DailyLimitRepository(),
        buildPolicies(config.limits),
        config,
      );
      server = new FakePayoutServer();
      real = new HttpPayoutClient(await server.start(), 300); // a hung create times out fast
    });

    afterAll(async () => {
      await server?.stop();
      if (ds?.isInitialized) await ds.destroy();
      jest.restoreAllMocks();
    });

    beforeEach(() => {
      // Each test starts from a clean, well-behaved provider; tests that need faults set them.
      server.transfers.clear();
      server.posts.clear();
      server.script = { onCreate: () => 'ok', finalStatus: () => 'SUCCEEDED' };
    });

    const handlers = (client: PayoutClient) => {
      const lifecycle = new WithdrawalLifecycleRepository();
      const attempts = new PayoutAttemptsRepository();
      return {
        submit: new WithdrawalSubmitHandler(
          runner,
          new WithdrawalsRepository(),
          lifecycle,
          attempts,
          outbox,
          client,
          config,
        ),
        sync: new WithdrawalSyncHandler(
          runner,
          lifecycle,
          attempts,
          new DailyLimitRepository(),
          ledger,
          outbox,
          client,
          config,
        ),
      };
    };
    const envelope = (
      type: string,
      id: string,
      payload: Record<string, string> = { withdrawalId: id },
    ): Envelope => ({
      messageId: randomUUID(),
      type,
      aggregateType: 'WITHDRAWAL',
      aggregateId: id,
      occurredAt: new Date().toISOString(),
      payload,
    });

    /** n users, each with one PENDING withdrawal of 150,000 toman (500,000 funded). */
    async function withdrawals(n: number) {
      const out: { id: string; userId: string }[] = [];
      for (let i = 0; i < n; i++) {
        const userId = `x11_${randomUUID().slice(0, 12)}`;
        await runner.run((tx) =>
          ledger.creditUser(tx, {
            userId,
            amount: Money.toman(500_000n),
            source: 'OPS_ADJUSTMENTS',
            kind: 'ADJUSTMENT_CREDIT',
            refId: randomUUID(),
          }),
        );
        const { response } = await service.request(
          {
            userId,
            amount: Money.toman(150_000n),
            destination: IBAN,
            body: { userId },
          },
          `x11-${randomUUID()}`,
        );
        out.push({
          id: (response.body as { withdrawalId: string }).withdrawalId,
          userId,
        });
      }
      return out;
    }

    const statuses = async (ids: string[]) =>
      new Map(
        (
          await ds.query<{ id: string; status: string }[]>(
            'SELECT id::text, status FROM withdrawals WHERE id = ANY($1::uuid[])',
            [ids],
          )
        ).map((r) => [r.id, r.status]),
      );

    /**
     * After a crash, time passes and the system resumes: leases expire, checks come due, the relay
     * delivers unsent jobs and the sweeper turns due rows into jobs; the real handlers run them.
     * Repeats until every withdrawal is final.
     * @returns how many rounds it took
     */
    async function drive(
      ids: string[],
      client: PayoutClient,
      maxRounds = 40,
    ): Promise<number> {
      const { submit, sync } = handlers(client);
      for (let round = 0; round < maxRounds; round++) {
        const s = await statuses(ids);
        if ([...s.values()].every((v) => v === 'SUCCEEDED' || v === 'FAILED'))
          return round;

        await ds.query(
          `UPDATE payout_attempts SET started_at = now() - interval '10 minutes'
          WHERE withdrawal_id = ANY($1::uuid[]) AND finished_at IS NULL`,
          [ids],
        );
        await ds.query(
          `UPDATE withdrawals SET next_check_at = now() - interval '1 second'
          WHERE id = ANY($1::uuid[]) AND next_check_at IS NOT NULL`,
          [ids],
        );
        // The relay: deliver unsent jobs with their payload (W5's resubmit carries a mark).
        const [relayed] = await ds.query<
          [
            {
              routing_key: string;
              aggregate_id: string;
              payload: Record<string, string>;
            }[],
            number,
          ]
        >(
          `UPDATE outbox SET published_at = now()
          WHERE aggregate_id = ANY($1::text[]) AND published_at IS NULL
          RETURNING routing_key, aggregate_id, payload`,
          [ids],
        );
        const swept = (
          await runner.run((tx) =>
            new WithdrawalDueWork().claimDue(tx, 1000, 30),
          )
        ).filter((j) => ids.includes(j.aggregateId));
        const jobs: Envelope[] = [
          ...relayed.map((r) =>
            envelope(r.routing_key, r.aggregate_id, r.payload),
          ),
          ...swept.map((j) => envelope(j.job, j.aggregateId, j.payload)),
        ];
        for (const j of jobs) {
          const handler = j.type === 'job.withdrawal.submit' ? submit : sync;
          await handler.handle(j).catch(() => undefined); // a crash is just a lost job
        }
      }
      throw new Error(
        `not settled after ${maxRounds} rounds: ${JSON.stringify([...(await statuses(ids))])}`,
      );
    }

    /** The guarantees, per withdrawal. */
    async function expectResolved(list: { id: string; userId: string }[]) {
      const ids = list.map((w) => w.id);
      // One transfer per requestId, and never one we did not ask for.
      expect([...server.transfers.keys()].sort()).toEqual([...ids].sort());
      const s = await statuses(ids);
      for (const { id, userId } of list) {
        const provider = server.transfers.get(id)!.final;
        // No withdrawal left unknown: final, and agreeing with the provider.
        expect(s.get(id)).toBe(provider === 'FAILED' ? 'FAILED' : 'SUCCEEDED');
        const [j] = await ds.query<
          { settle: number; release: number; ret: number }[]
        >(
          `SELECT count(*) FILTER (WHERE kind = 'WITHDRAWAL_SETTLE')::int AS settle,
                count(*) FILTER (WHERE kind = 'WITHDRAWAL_RELEASE')::int AS release,
                count(*) FILTER (WHERE kind = 'WITHDRAWAL_RETURN')::int AS ret
           FROM journals WHERE ref_id = $1`,
          [id],
        );
        expect(j).toEqual({
          settle: provider === 'FAILED' ? 0 : 1,
          release: provider === 'FAILED' ? 1 : 0,
          ret: provider === 'RETURNED' ? 1 : 0,
        });
        const [{ frozen }] = await ds.query<{ frozen: string }[]>(
          `SELECT balance_minor::text AS frozen FROM accounts WHERE user_id = $1 AND kind = 'FROZEN' AND currency = 'IRR'`,
          [userId],
        );
        expect(frozen).toBe('0');
      }
      const report = await new InvariantsService(
        runner,
        ledger,
        service,
      ).check();
      const users = new Set(list.map((w) => w.userId));
      expect(
        report.checks.flatMap((c) =>
          c.violations.filter((v) => users.has(v.user_id ?? '')),
        ),
      ).toEqual([]);
    }

    describe('a crash at each of the three points', () => {
      it('after the W1 commit, before the HTTP call: GET 404, resubmitted with the same requestId', async () => {
        const list = await withdrawals(1);
        const [{ id }] = list;
        const crashing = new CrashingPayout(real, () => 'after-W1-before-call');
        await expect(
          handlers(crashing).submit.handle(
            envelope('job.withdrawal.submit', id),
          ),
        ).rejects.toThrow(ProcessDied);
        expect((await statuses([id])).get(id)).toBe('SUBMITTING');
        expect(server.posts.get(id)).toBeUndefined(); // nothing reached the provider

        await drive([id], real);
        expect(server.posts.get(id)).toBe(1);
        await expectResolved(list);
      });

      it('after the HTTP call, before recording it: GET finds it, never resubmitted', async () => {
        const list = await withdrawals(1);
        const [{ id }] = list;
        const crashing = new CrashingPayout(
          real,
          () => 'after-call-before-record',
        );
        await expect(
          handlers(crashing).submit.handle(
            envelope('job.withdrawal.submit', id),
          ),
        ).rejects.toThrow(ProcessDied);
        expect(server.transfers.has(id)).toBe(true); // created, but we never wrote that down

        await drive([id], real);
        expect(server.posts.get(id)).toBe(1); // we asked (GET) before resubmitting
        await expectResolved(list);
      });

      it('after the provider succeeded, before settling: the next sync settles it, once', async () => {
        const list = await withdrawals(1);
        const [{ id }] = list;
        await drive(
          [id],
          new CrashingPayout(real, () => 'after-success-before-settle'),
        );
        await expectResolved(list);
      });
    });

    describe.each<[string, CreateFault, number]>([
      ['PAY-03: a 503 that created it', '503-created', 1],
      ['a 503 that did not create it', '503-lost', 2],
      ['PAY-04: a timeout that created it', 'timeout-created', 1],
      ['PAY-04: a connection reset that created it', 'reset-created', 1],
    ])('%s', (_finding, fault, posts) => {
      it(`ends with one transfer and the withdrawal settled (${posts} POST${posts > 1 ? 's' : ''})`, async () => {
        server.script = {
          onCreate: (_id, attempt) => (attempt === 1 ? fault : 'ok'),
          finalStatus: () => 'SUCCEEDED',
        };
        const list = await withdrawals(1);
        await drive([list[0].id], real);
        expect(server.posts.get(list[0].id)).toBe(posts);
        await expectResolved(list);
      });
    });

    it('chaos: 20 withdrawals, random faults on every create, a crash point each, mixed outcomes', async () => {
      const random = rng(103);
      const faults: CreateFault[] = [
        'ok',
        'ok',
        '503-created',
        '503-lost',
        'timeout-created',
        'reset-created',
      ];
      const finals: TransferStatus[] = [
        'SUCCEEDED',
        'SUCCEEDED',
        'SUCCEEDED',
        'FAILED',
        'RETURNED',
      ];
      const final = new Map<string, TransferStatus>();
      server.script = {
        onCreate: () => faults[Math.floor(random() * faults.length)],
        finalStatus: (id) => final.get(id) ?? 'SUCCEEDED',
      };
      const list = await withdrawals(20);
      const points: (CrashPoint | null)[] = [
        'after-W1-before-call',
        'after-call-before-record',
        'after-success-before-settle',
        null,
      ];
      const crashAt = new Map(
        list.map((w) => [w.id, points[Math.floor(random() * points.length)]]),
      );
      for (const w of list)
        final.set(w.id, finals[Math.floor(random() * finals.length)]);

      const rounds = await drive(
        list.map((w) => w.id),
        new CrashingPayout(real, (id) => crashAt.get(id) ?? null),
      );

      expect(rounds).toBeGreaterThan(0);
      await expectResolved(list);
    }, 120_000);
  },
);
