import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { Money } from '../../common/money';
import { loadConfig } from '../../config/app-config';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { TransactionRunner } from '../../database/transaction-runner';
import { newIdempotencyService } from '../idempotency/testing';
import { HttpPspClient } from '../integrations/psp/http-psp.client';
import type { PspClient } from '../integrations/psp';
import {
  FakePspServer,
  PspCreateFault,
} from '../integrations/psp/testing/fake-psp-server';
import { DepositService } from './deposit.service';
import { DepositsRepository } from './repositories/deposits.repository';

const LEASE_SECONDS = 2;
const HTTP_TIMEOUT_MS = 1000;
const PUBLIC_BASE_URL = 'http://app.test:3000';

describeDb('POST /deposits and GET /deposits/:id (real PostgreSQL)', () => {
  let ds: DataSource;
  let app: INestApplication<App>;
  const psp = new FakePspServer();
  let fault: PspCreateFault = 'ok';
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    ds = await connectTestDb();
    psp.script = { onCreate: () => fault, verify503: () => false };
    Object.assign(process.env, {
      PSP_BASE_URL: await psp.start(),
      PUBLIC_BASE_URL,
      HTTP_TIMEOUT_MS: String(HTTP_TIMEOUT_MS),
      DEPOSIT_CREATE_LEASE_SECONDS: String(LEASE_SECONDS),
    });
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRole('api')],
    }).compile();
    app = ref.createNestApplication({ rawBody: true });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await psp.stop();
    if (ds?.isInitialized) await ds.destroy();
    process.env = savedEnv;
  });

  beforeEach(() => {
    fault = 'ok';
    psp.creates = 0;
    psp.payments.clear();
  });

  const newUser = () => `d3_${randomUUID().slice(0, 12)}`;
  const newKey = () => `d3-${randomUUID()}`;
  const deposit = (body: object, key: string | null = newKey()) => {
    const r = request(app.getHttpServer()).post('/deposits');
    if (key !== null) r.set('Idempotency-Key', key);
    return r.send(body);
  };
  const body = (userId = newUser(), amount = '1000') => ({ userId, amount });

  const depositRows = (userId: string) =>
    ds.query<
      {
        id: string;
        status: string;
        amount_rial: string;
        psp_token: string | null;
        payment_url: string | null;
        psp_status: string | null;
        failure_reason: string | null;
        completed_at: Date | null;
        next_check_ok: boolean | null;
        expiry_is_24h: boolean;
      }[]
    >(
      `SELECT id, status, amount_rial::text, psp_token, payment_url, psp_status,
              failure_reason, completed_at,
              next_check_at > now() + interval '10 seconds'
                AND next_check_at < now() + interval '20 seconds' AS next_check_ok,
              expires_at - created_at = interval '1440 minutes' AS expiry_is_24h
         FROM deposits WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
  const keyRow = async (key: string) =>
    (
      await ds.query<
        {
          status: string;
          response_status: number | null;
          resource_type: string | null;
          resource_id: string | null;
          lease_active: boolean;
        }[]
      >(
        `SELECT status, response_status, resource_type, resource_id,
                locked_until > now() AS lease_active
           FROM idempotency_keys WHERE key = $1`,
        [key],
      )
    )[0];
  /** A JSON response body, whose fields these tests read as strings. */
  const json = (res: request.Response): Record<string, string> =>
    res.body as Record<string, string>;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  describe('a successful create', () => {
    it('answers 201 PENDING with the payment link and stores the deposit, token and key together', async () => {
      const userId = newUser();
      const key = newKey();
      const res = await deposit(body(userId, '1000'), key).expect(201);

      const [d] = await depositRows(userId);
      expect(res.body).toEqual({
        depositId: d.id,
        status: 'PENDING',
        paymentUrl: d.payment_url,
      });
      expect(d).toMatchObject({
        status: 'PENDING',
        amount_rial: '10000',
        psp_status: 'INIT',
        failure_reason: null,
        completed_at: null,
        next_check_ok: true,
        expiry_is_24h: true,
      });
      expect(d.psp_token).toMatch(/^A0/);
      expect(await keyRow(key)).toMatchObject({
        status: 'COMPLETED',
        response_status: 201,
        resource_type: 'DEPOSIT',
        resource_id: d.id,
      });
    });

    it('sends the PSP rial, our deposit id as orderId and a callback URL that carries it (PSP-01, PSP-03)', async () => {
      const userId = newUser();
      const res = await deposit(body(userId, '2500')).expect(201);
      const sent = psp.payments.get(
        (await depositRows(userId))[0].psp_token as string,
      );
      expect(sent).toMatchObject({
        amount: '25000',
        orderId: json(res).depositId,
        callbackUrl: `${PUBLIC_BASE_URL}/webhooks/psp/callback/${json(res).depositId}`,
      });
    });

    it('accepts the minimum, 1,000 toman, and an explicit IRT currency', async () => {
      await deposit({ ...body(newUser(), '1000'), currency: 'IRT' }).expect(
        201,
      );
    });

    it('makes a separate deposit for a different key, even with the same body', async () => {
      const b = body();
      const a = await deposit(b).expect(201);
      const c = await deposit(b).expect(201);
      expect(json(a).depositId).not.toBe(json(c).depositId);
      expect(psp.creates).toBe(2);
    });
  });

  describe('idempotency (the same key)', () => {
    it('replays the identical response and creates nothing twice', async () => {
      const userId = newUser();
      const key = newKey();
      const first = await deposit(body(userId), key).expect(201);
      const again = await deposit(body(userId), key).expect(201);

      expect(again.body).toEqual(first.body);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(await depositRows(userId)).toHaveLength(1);
      expect(psp.creates).toBe(1);
    });

    it('refuses the key with another body: 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const key = newKey();
      const userId = newUser();
      await deposit(body(userId, '1000'), key).expect(201);
      const res = await deposit(body(userId, '2000'), key).expect(422);
      expect(json(res).code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(psp.creates).toBe(1);
    });

    it('twenty parallel twins make one deposit and one PSP payment', async () => {
      const userId = newUser();
      const key = newKey();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => deposit(body(userId), key)),
      );

      const created = results.filter((r) => r.status === 201);
      expect(created.length).toBeGreaterThanOrEqual(1);
      for (const r of results) expect([201, 409]).toContain(r.status);
      for (const r of results.filter((x) => x.status === 409)) {
        expect(json(r).code).toBe('IDEMPOTENCY_IN_PROGRESS');
      }
      for (const r of created) expect(r.body).toEqual(created[0].body);
      expect(await depositRows(userId)).toHaveLength(1);
      expect(psp.creates).toBe(1);
    }, 30_000);
  });

  describe('refused before anything is written', () => {
    it('no Idempotency-Key: 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
      const userId = newUser();
      const res = await deposit(body(userId), null).expect(400);
      expect(json(res).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect(await depositRows(userId)).toHaveLength(0);
    });

    it('below 1,000 toman: 422 BELOW_MINIMUM, no deposit, no key, no PSP call', async () => {
      const userId = newUser();
      const key = newKey();
      const res = await deposit(body(userId, '999'), key).expect(422);
      expect(json(res).code).toBe('BELOW_MINIMUM');
      expect(await depositRows(userId)).toHaveLength(0);
      expect(await keyRow(key)).toBeUndefined();
      expect(psp.creates).toBe(0);
    });

    it.each([
      ['an amount with an exponent', { amount: '1e5' }],
      ['a fractional toman', { amount: '1000.5' }],
      ['a JSON number amount', { amount: 1000 }],
      ['a negative amount', { amount: '-1000' }],
      ['an unknown currency', { currency: 'USDT' }],
      ['a malformed userId', { userId: 'not valid!' }],
      ['an unknown field', { note: 'hi' }],
    ])('%s: 400 VALIDATION_ERROR', async (_name, over) => {
      const res = await deposit({ ...body(), ...over }).expect(400);
      expect(json(res).code).toBe('VALIDATION_ERROR');
      expect(psp.creates).toBe(0);
    });
  });

  describe('the PSP says no', () => {
    it('a rejection fails the deposit (PSP_REJECTED) and is stored: a repeat answers the same', async () => {
      fault = 'reject';
      const userId = newUser();
      const key = newKey();
      const res = await deposit(body(userId), key).expect(201);
      const [d] = await depositRows(userId);

      expect(res.body).toEqual({
        depositId: d.id,
        status: 'FAILED',
        paymentUrl: null,
      });
      expect(d).toMatchObject({
        status: 'FAILED',
        failure_reason: 'PSP_REJECTED',
        psp_token: null,
      });
      expect(d.completed_at).not.toBeNull();

      fault = 'ok';
      const again = await deposit(body(userId), key).expect(201);
      expect(again.body).toEqual(res.body);
      expect(psp.creates).toBe(1);
    });
  });

  describe('the PSP is unreachable (D3, D4)', () => {
    it.each(['503', 'timeout', 'reset'] as const)(
      '%s: 503 PROVIDER_UNAVAILABLE, nothing stored, the retry resumes the same deposit',
      async (f) => {
        fault = f;
        const userId = newUser();
        const key = newKey();
        const failed = await deposit(body(userId), key).expect(503);
        expect(json(failed).code).toBe('PROVIDER_UNAVAILABLE');

        const [created] = await depositRows(userId);
        expect(created).toMatchObject({ status: 'CREATED', psp_token: null });
        expect(await keyRow(key)).toMatchObject({
          status: 'IN_PROGRESS',
          lease_active: false,
          resource_id: created.id,
        });

        fault = 'ok';
        const retry = await deposit(body(userId), key).expect(201);
        expect(retry.body).toMatchObject({
          depositId: created.id,
          status: 'PENDING',
        });
        const rows = await depositRows(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('PENDING');
        expect(psp.creates).toBe(2);
      },
    );

    it('a third try after a second failure still resumes the same deposit', async () => {
      const userId = newUser();
      const key = newKey();
      fault = '503';
      await deposit(body(userId), key).expect(503);
      await deposit(body(userId), key).expect(503);
      fault = 'ok';
      const res = await deposit(body(userId), key).expect(201);
      expect(await depositRows(userId)).toHaveLength(1);
      expect(json(res).status).toBe('PENDING');
    });
  });

  describe('a crash between the two phases (A5)', () => {
    const crashing: PspClient = {
      createPayment: () => Promise.reject(new Error('process died')),
      getPayment: () => Promise.reject(new Error('not used')),
      verify: () => Promise.reject(new Error('not used')),
      getSettlement: () => Promise.reject(new Error('not used')),
    };
    const config = () => loadConfig({ ...process.env });
    const runner = () =>
      new TransactionRunner(ds, {
        lockTimeoutMs: 10_000,
        statementTimeoutMs: 20_000,
      });
    const service = (client: PspClient) =>
      new DepositService(
        runner(),
        newIdempotencyService(),
        new DepositsRepository(),
        client,
        config(),
      );
    const cmd = (userId: string) => ({
      userId,
      amount: Money.toman(1000n),
      body: { userId, amount: '1000' },
    });

    it('leaves the key leased and the deposit CREATED; a retry inside the lease gets 409; after it, the same key resumes the same deposit', async () => {
      const userId = newUser();
      const key = newKey();
      await expect(service(crashing).create(cmd(userId), key)).rejects.toThrow(
        'process died',
      );

      const [orphan] = await depositRows(userId);
      expect(orphan).toMatchObject({ status: 'CREATED', psp_token: null });
      expect(await keyRow(key)).toMatchObject({
        status: 'IN_PROGRESS',
        lease_active: true,
        resource_id: orphan.id,
      });

      const live = new HttpPspClient(process.env.PSP_BASE_URL as string, 500);
      await expect(
        service(live).create(cmd(userId), key),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
      expect(psp.creates).toBe(0);

      await sleep(LEASE_SECONDS * 1000 + 300);
      const resumed = await service(live).create(cmd(userId), key);

      expect(resumed.replayed).toBe(false);
      expect(resumed.response.status).toBe(201);
      expect(resumed.response.body).toMatchObject({
        depositId: orphan.id,
        status: 'PENDING',
      });
      const rows = await depositRows(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('PENDING');
      expect(psp.creates).toBe(1);
      expect(await keyRow(key)).toMatchObject({ status: 'COMPLETED' });
    }, 20_000);

    it('after the resume, the same key replays the stored answer', async () => {
      const userId = newUser();
      const key = newKey();
      await expect(
        service(crashing).create(cmd(userId), key),
      ).rejects.toThrow();
      await sleep(LEASE_SECONDS * 1000 + 300);
      const live = new HttpPspClient(process.env.PSP_BASE_URL as string, 500);
      const resumed = await service(live).create(cmd(userId), key);
      const replay = await service(live).create(cmd(userId), key);
      expect(replay).toEqual({ response: resumed.response, replayed: true });
      expect(psp.creates).toBe(1);
    }, 20_000);

    it('refuses a lease that does not outlast the HTTP timeout', () => {
      const tooShort = loadConfig({
        ...process.env,
        DEPOSIT_CREATE_LEASE_SECONDS: '5',
        HTTP_TIMEOUT_MS: '5000',
      });
      expect(
        () =>
          new DepositService(
            runner(),
            newIdempotencyService(),
            new DepositsRepository(),
            crashing,
            tooShort,
          ),
      ).toThrow(/DEPOSIT_CREATE_LEASE_SECONDS/);
    });
  });

  describe('GET /deposits/:id', () => {
    it('shows a pending deposit with its link and toman amount', async () => {
      const userId = newUser();
      const created = await deposit(body(userId, '2500')).expect(201);
      const res = await request(app.getHttpServer())
        .get(`/deposits/${json(created).depositId}`)
        .expect(200);
      expect(res.body).toMatchObject({
        depositId: json(created).depositId,
        status: 'PENDING',
        userId,
        currency: 'IRT',
        amount: '2500',
        creditedAmount: null,
        paymentUrl: json(created).paymentUrl,
        failureReason: null,
        needsReview: false,
      });
      expect(Date.parse(json(res).expiresAt)).toBeGreaterThan(Date.now());
    });

    it('shows a failed deposit with its reason', async () => {
      fault = 'reject';
      const created = await deposit(body()).expect(201);
      const res = await request(app.getHttpServer())
        .get(`/deposits/${json(created).depositId}`)
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'FAILED',
        failureReason: 'PSP_REJECTED',
        paymentUrl: null,
      });
    });

    it.each([randomUUID(), 'not-a-uuid', '123'])(
      'an unknown or malformed id (%s) is 404 NOT_FOUND',
      async (id) => {
        const res = await request(app.getHttpServer())
          .get(`/deposits/${id}`)
          .expect(404);
        expect(json(res).code).toBe('NOT_FOUND');
      },
    );
  });
});
