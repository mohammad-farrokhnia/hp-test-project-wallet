import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Money } from '../../../common/money';
import { AppConfig, loadConfig } from '../../../config/app-config';
import { connectTestDb, describeDb } from '../../../database/int-testing';
import { TransactionRunner } from '../../../database/transaction-runner';
import { newIdempotencyService } from '../../idempotency/testing';
import type {
  CreatePaymentOutcome,
  PaymentLookup,
  PspClient,
  VerifyOutcome,
} from '../../integrations/psp';
import { HttpPspClient } from '../../integrations/psp/http-psp.client';
import { FakePspServer } from '../../integrations/psp/testing/fake-psp-server';
import { newLedgerService } from '../../ledger/testing';
import { DepositService } from '../deposit.service';
import { DepositLifecycleRepository } from '../repositories/deposit-lifecycle.repository';
import { DepositsRepository } from '../repositories/deposits.repository';
import { DepositSyncHandler } from './deposit-sync.handler';

class SpyPsp implements PspClient {
  lookups = 0;
  verifies = 0;
  lookup?: () => PaymentLookup;
  verifyAs?: () => VerifyOutcome;
  constructor(private readonly inner: PspClient) {}
  reset(): void {
    this.lookups = 0;
    this.verifies = 0;
    this.lookup = undefined;
    this.verifyAs = undefined;
  }
  createPayment(
    ...args: Parameters<PspClient['createPayment']>
  ): Promise<CreatePaymentOutcome> {
    return this.inner.createPayment(...args);
  }
  getPayment(token: string): Promise<PaymentLookup> {
    this.lookups++;
    return this.lookup
      ? Promise.resolve(this.lookup())
      : this.inner.getPayment(token);
  }
  verify(token: string): Promise<VerifyOutcome> {
    this.verifies++;
    return this.verifyAs
      ? Promise.resolve(this.verifyAs())
      : this.inner.verify(token);
  }
}

interface Pending {
  id: string;
  token: string;
  userId: string;
}

describeDb('DepositSyncHandler: the state machine on real PostgreSQL', () => {
  let ds: DataSource;
  let handler: DepositSyncHandler;
  let service: DepositService;
  let spy: SpyPsp;
  let config: AppConfig;
  const fake = new FakePspServer();
  let verify503Once = false;

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation();
    }
    ds = await connectTestDb();
    fake.script = {
      onCreate: () => 'ok',
      verify503: (_token, attempt) => verify503Once && attempt === 1,
    };
    const runner = new TransactionRunner(ds, {
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 20_000,
    });
    config = loadConfig();
    spy = new SpyPsp(new HttpPspClient(await fake.start(), 1000));
    service = new DepositService(
      runner,
      newIdempotencyService(),
      new DepositsRepository(),
      spy,
      config,
    );
    handler = new DepositSyncHandler(
      runner,
      new DepositLifecycleRepository(),
      newLedgerService(),
      spy,
    );
  });

  afterAll(async () => {
    await fake.stop();
    if (ds?.isInitialized) await ds.destroy();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    spy.reset();
    verify503Once = false;
  });

  /** A real PENDING deposit of 1,000 toman (10,000 rial). */
  async function pending(toman = 1000n): Promise<Pending> {
    const userId = `d5_${randomUUID().slice(0, 12)}`;
    const { response } = await service.create(
      {
        userId,
        amount: Money.toman(toman),
        body: { userId, amount: String(toman) },
      },
      `d5-${randomUUID()}`,
    );
    const id = (response.body as { depositId: string }).depositId;
    const [{ psp_token: token }] = await ds.query<{ psp_token: string }[]>(
      'SELECT psp_token FROM deposits WHERE id = $1',
      [id],
    );
    return { id, token, userId };
  }
  const payment = (d: Pending) => {
    const p = fake.payments.get(d.token);
    if (!p) throw new Error('payment is gone');
    return p;
  };
  const sync = (id: string) =>
    handler.handle({
      messageId: randomUUID(),
      type: 'job.deposit.sync',
      aggregateType: 'DEPOSIT',
      aggregateId: id,
      occurredAt: new Date().toISOString(),
      payload: { depositId: id, trigger: 'CALLBACK' },
    });

  const row = async (id: string) =>
    (
      await ds.query<
        {
          status: string;
          psp_status: string | null;
          credited_rial: string | null;
          psp_ref_id: string | null;
          failure_reason: string | null;
          needs_review: boolean;
          review_reason: string | null;
          paid_seen: boolean;
          completed: boolean;
          check_attempts: number;
          next_in: number | null;
        }[]
      >(
        `SELECT status, psp_status, credited_rial::text, psp_ref_id, failure_reason,
                needs_review, review_reason,
                paid_seen_at IS NOT NULL AS paid_seen,
                completed_at IS NOT NULL AS completed,
                check_attempts,
                extract(epoch FROM next_check_at - now())::float AS next_in
           FROM deposits WHERE id = $1`,
        [id],
      )
    )[0];
  const journalLines = (id: string) =>
    ds.query<{ kind: string; account_kind: string; amount: string }[]>(
      `SELECT j.kind, p.account_kind, p.amount_minor::text AS amount
         FROM journals j JOIN postings p ON p.journal_id = j.id
        WHERE j.ref_id = $1 ORDER BY p.amount_minor`,
      [id],
    );
  const available = async (userId: string) =>
    (
      await ds.query<{ b: string }[]>(
        `SELECT balance_minor::text AS b FROM accounts WHERE user_id = $1 AND kind = 'AVAILABLE'`,
        [userId],
      )
    )[0]?.b;

  const secondsAround = (n: number | null, expected: number) => {
    expect(n).not.toBeNull();
    expect(n as number).toBeGreaterThan(expected - 6);
    expect(n as number).toBeLessThanOrEqual(expected + 1);
  };

  describe('credit', () => {
    it('PAID and verified → SUCCEEDED, credited with the verified amount, in one journal (D8)', async () => {
      const d = await pending();
      fake.pay(d.token);

      await sync(d.id);

      expect(await row(d.id)).toMatchObject({
        status: 'SUCCEEDED',
        psp_status: 'VERIFIED',
        credited_rial: '10000',
        psp_ref_id: payment(d).refId,
        failure_reason: null,
        needs_review: false,
        completed: true,
        next_in: null,
      });
      expect(await journalLines(d.id)).toEqual([
        {
          kind: 'DEPOSIT_CREDIT',
          account_kind: 'PSP_CLEARING',
          amount: '-10000',
        },
        { kind: 'DEPOSIT_CREDIT', account_kind: 'AVAILABLE', amount: '10000' },
      ]);
      expect(await available(d.userId)).toBe('10000');
    });

    it('a crash after verify OK and before crediting: the next sync gets 101 and credits (crash table)', async () => {
      const d = await pending();
      fake.pay(d.token);
      expect((await spy.verify(d.token)).kind).toBe('OK');
      expect(payment(d).status).toBe('VERIFIED');
      expect(await row(d.id)).toMatchObject({ status: 'PENDING' });

      await sync(d.id);

      expect(await row(d.id)).toMatchObject({
        status: 'SUCCEEDED',
        credited_rial: '10000',
      });
      expect(await journalLines(d.id)).toHaveLength(2);
    });

    it('credits what verify returns, flagged when it differs from the request (PSP-07)', async () => {
      const d = await pending();
      fake.pay(d.token);
      const refId = `REF-${randomUUID()}`;
      spy.verifyAs = () => ({
        kind: 'OK',
        amount: Money.rial(9_000n),
        refId,
      });

      await sync(d.id);

      expect(await row(d.id)).toMatchObject({
        status: 'SUCCEEDED',
        credited_rial: '9000',
        psp_ref_id: refId,
        needs_review: true,
        review_reason: 'AMOUNT_DIFFERS',
      });
      expect(await available(d.userId)).toBe('9000');
    });

    it('five syncs at once credit exactly once', async () => {
      const d = await pending();
      fake.pay(d.token);

      await Promise.all([1, 2, 3, 4, 5].map(() => sync(d.id)));

      expect(await row(d.id)).toMatchObject({ status: 'SUCCEEDED' });
      expect(await journalLines(d.id)).toHaveLength(2);
      expect(await available(d.userId)).toBe('10000');
    });

    it('a bank reference that already credited another deposit is refused, not credited twice', async () => {
      const a = await pending();
      const b = await pending();
      fake.pay(a.token);
      fake.pay(b.token);
      payment(b).refId = payment(a).refId;
      await sync(a.id);

      await expect(sync(b.id)).rejects.toThrow(/deposits_psp_ref_id_key/);

      expect(await row(b.id)).toMatchObject({
        status: 'PENDING',
        credited_rial: null,
      });
      expect(await journalLines(b.id)).toEqual([]);
      expect(await available(b.userId)).toBeUndefined();
    });
  });

  describe('keeps it PENDING and tries again', () => {
    it('PSP status INIT: no verify is made (-51 while INIT), the check is counted and the poll schedule is followed (D6)', async () => {
      const d = await pending();

      await sync(d.id);
      expect(await row(d.id)).toMatchObject({
        status: 'PENDING',
        psp_status: 'INIT',
        paid_seen: false,
        check_attempts: 1,
      });
      secondsAround((await row(d.id)).next_in, 15);
      expect(spy.verifies).toBe(0);

      await sync(d.id);
      secondsAround((await row(d.id)).next_in, 15);
      await sync(d.id);
      secondsAround((await row(d.id)).next_in, 30);
      expect(await row(d.id)).toMatchObject({ check_attempts: 3 });
      expect(spy.verifies).toBe(0);
      expect(await journalLines(d.id)).toEqual([]);
    });

    it('verify answers 503 (not applied): stays PENDING, retries in 5 s, then credits (PSP-09, D9)', async () => {
      const d = await pending();
      fake.pay(d.token);
      verify503Once = true;

      await sync(d.id);

      expect(await row(d.id)).toMatchObject({
        status: 'PENDING',
        psp_status: 'PAID',
        paid_seen: true,
        credited_rial: null,
      });
      secondsAround((await row(d.id)).next_in, 5);
      expect(payment(d).status).toBe('PAID');

      await sync(d.id);

      expect(await row(d.id)).toMatchObject({
        status: 'SUCCEEDED',
        credited_rial: '10000',
      });
    });

    it('verify answers -51 for a PAID payment: stays PENDING and reads the status again in 5 s (PSP-08, D10)', async () => {
      const d = await pending();
      fake.pay(d.token);
      spy.verifyAs = () => ({ kind: 'NOT_PAID' });

      await sync(d.id);

      expect(await row(d.id)).toMatchObject({
        status: 'PENDING',
        failure_reason: null,
        paid_seen: true,
      });
      secondsAround((await row(d.id)).next_in, 5);

      spy.verifyAs = undefined;
      await sync(d.id);
      expect(await row(d.id)).toMatchObject({ status: 'SUCCEEDED' });
    });

    it('the PSP is unreachable: nothing changes but the next check, never FAILED', async () => {
      const d = await pending();
      spy.lookup = () => ({ kind: 'UNAVAILABLE', reason: 'timeout' });

      await sync(d.id);

      expect(await row(d.id)).toMatchObject({
        status: 'PENDING',
        psp_status: 'INIT',
        failure_reason: null,
        check_attempts: 1,
      });
      expect(spy.verifies).toBe(0);
    });

    it('the PSP does not know the token: flagged UNKNOWN_TOKEN, checked again in 5 minutes, never FAILED (D16)', async () => {
      const d = await pending();
      fake.payments.delete(d.token);

      await sync(d.id);

      expect(await row(d.id)).toMatchObject({
        status: 'PENDING',
        needs_review: true,
        review_reason: 'UNKNOWN_TOKEN',
      });
      secondsAround((await row(d.id)).next_in, 300);
    });
  });

  describe('fails the deposit only on the PSP status', () => {
    it('FAILED → FAILED (PSP_FAILED), nothing credited (D11)', async () => {
      const d = await pending();
      payment(d).status = 'FAILED';

      await sync(d.id);

      expect(await row(d.id)).toMatchObject({
        status: 'FAILED',
        failure_reason: 'PSP_FAILED',
        psp_status: 'FAILED',
        credited_rial: null,
        completed: true,
        next_in: null,
      });
      expect(await journalLines(d.id)).toEqual([]);
      expect(spy.verifies).toBe(0);
    });

    it('REVERSED → FAILED (PSP_REVERSED), flagged, nothing credited (PSP-10, D12)', async () => {
      const d = await pending();
      payment(d).status = 'REVERSED';

      await sync(d.id);

      expect(await row(d.id)).toMatchObject({
        status: 'FAILED',
        failure_reason: 'PSP_REVERSED',
        needs_review: true,
        review_reason: 'UNVERIFIED_TOO_LONG',
        completed: true,
      });
      expect(await journalLines(d.id)).toEqual([]);
    });
  });

  describe('a settled or unissued deposit costs no PSP call', () => {
    it('a SUCCEEDED deposit is left alone however often the job repeats', async () => {
      const d = await pending();
      fake.pay(d.token);
      await sync(d.id);
      spy.reset();

      await sync(d.id);
      await sync(d.id);

      expect(spy.lookups).toBe(0);
      expect(await journalLines(d.id)).toHaveLength(2);
      expect(await available(d.userId)).toBe('10000');
    });

    it('a FAILED deposit is not revived by a payment that arrives later', async () => {
      const d = await pending();
      payment(d).status = 'FAILED';
      await sync(d.id);
      fake.pay(d.token);
      spy.reset();

      await sync(d.id);

      expect(spy.lookups).toBe(0);
      expect(await row(d.id)).toMatchObject({
        status: 'FAILED',
        credited_rial: null,
      });
    });

    it('a CREATED deposit (no token yet) and an unknown id are ignored', async () => {
      const id = randomUUID();
      await ds.query(
        `INSERT INTO deposits (id, user_id, amount_rial, status, expires_at)
         VALUES ($1, 'd5_created', 10000, 'CREATED', now() + interval '1 day')`,
        [id],
      );
      await sync(id);
      await sync(randomUUID());
      expect(spy.lookups).toBe(0);
      expect(await row(id)).toMatchObject({ status: 'CREATED' });
    });
  });

  describe('expiry after 24 hours (ADR-11, D7)', () => {
    const expire = (d: Pending) =>
      ds.query(
        `UPDATE deposits
            SET created_at = now() - interval '2 days',
                expires_at = now() - interval '1 minute'
          WHERE id = $1`,
        [d.id],
      );

    it('a deposit the PSP still shows as INIT after expires_at becomes FAILED (EXPIRED), final, nothing credited', async () => {
      const d = await pending();
      await expire(d);

      await sync(d.id);

      expect(await row(d.id)).toMatchObject({
        status: 'FAILED',
        failure_reason: 'EXPIRED',
        psp_status: 'INIT',
        credited_rial: null,
        completed: true,
        next_in: null,
      });
      expect(await journalLines(d.id)).toEqual([]);
      expect(spy.verifies).toBe(0);
    });

    it('before expires_at the same INIT deposit stays PENDING', async () => {
      const d = await pending();
      await sync(d.id);
      expect(await row(d.id)).toMatchObject({ status: 'PENDING' });
    });

    it('a payment that is PAID by then is still verified and credited: only INIT expires', async () => {
      const d = await pending();
      fake.pay(d.token);
      await expire(d);

      await sync(d.id);

      expect(await row(d.id)).toMatchObject({
        status: 'SUCCEEDED',
        credited_rial: '10000',
      });
    });

    const silent: [string, () => PaymentLookup][] = [
      ['the PSP does not answer', () => ({ kind: 'UNAVAILABLE', reason: 'x' })],
      ['the PSP does not know the token', () => ({ kind: 'NOT_FOUND' })],
    ];
    it.each(silent)(
      '%s after expires_at: never expired on silence',
      async (_c, lookup) => {
        const d = await pending();
        await expire(d);
        spy.lookup = lookup;

        await sync(d.id);

        expect(await row(d.id)).toMatchObject({
          status: 'PENDING',
          failure_reason: null,
        });
      },
    );

    it('a PAID payment whose verify is unavailable after expires_at stays PENDING and retries', async () => {
      const d = await pending();
      fake.pay(d.token);
      await expire(d);
      spy.verifyAs = () => ({ kind: 'UNAVAILABLE', reason: 'HTTP_503' });

      await sync(d.id);

      expect(await row(d.id)).toMatchObject({ status: 'PENDING' });
      secondsAround((await row(d.id)).next_in, 5);
    });
  });
});
