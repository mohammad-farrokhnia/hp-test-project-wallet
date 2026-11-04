import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { connectTestDb, describeDb } from '../../database/int-testing';
import { TransactionRunner } from '../../database/transaction-runner';
import { ClaimRequest, StoredResponse } from './idempotency.types';
import { newIdempotencyService } from './testing';

describeDb('IdempotencyService (real PostgreSQL)', () => {
  let ds: DataSource;
  let runner: TransactionRunner;
  const idem = newIdempotencyService();

  const SCOPE = 'POST /withdrawals';
  const body = { userId: 'alice', currency: 'IRT', amount: '100000' };
  const created: StoredResponse = {
    status: 201,
    body: { withdrawalId: randomUUID(), status: 'PENDING' },
  };
  const newKey = () => `it-${randomUUID()}`;
  const req = (key: string, b: unknown = body): ClaimRequest => ({
    key,
    scope: SCOPE,
    body: b,
  });

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

  /** The usual endpoint shape: claim, do the work if NEW, store the response, all in one transaction. */
  const handle = (key: string, b: unknown = body, response = created) =>
    runner.run(async (tx) => {
      const claim = await idem.claim(tx, req(key, b));
      if (claim.kind === 'REPLAY') return { replayed: true, ...claim.response };
      await idem.complete(tx, key, response);
      return { replayed: false, ...response };
    });

  describe('claim (single-transaction endpoints)', () => {
    it('a sequential replay returns the identical status and body', async () => {
      const key = newKey();
      const first = await handle(key);
      const again = await handle(key);

      expect(first).toEqual({ replayed: false, ...created });
      expect(again).toEqual({ replayed: true, ...created });
    });

    it('replays the body byte for byte, key order included', async () => {
      const key = newKey();
      const response = {
        status: 201,
        body: { zeta: 1, alpha: { b: 2, a: 1 } },
      };
      await handle(key, body, response);
      const again = await handle(key);
      expect(JSON.stringify(again.body)).toBe(JSON.stringify(response.body));
    });

    it('replays a stored state-dependent 422 too', async () => {
      const key = newKey();
      const rejected = {
        status: 422,
        body: { code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds' },
      };
      await handle(key, body, rejected);
      expect(await handle(key)).toEqual({ replayed: true, ...rejected });
    });

    it('accepts the same body with its keys in another order', async () => {
      const key = newKey();
      await handle(key);
      const again = await handle(key, {
        amount: '100000',
        userId: 'alice',
        currency: 'IRT',
      });
      expect(again.replayed).toBe(true);
    });

    it('a different body returns 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const key = newKey();
      await handle(key);
      await expect(
        handle(key, { ...body, amount: '200000' }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 422 });
    });

    it('the same key on another route returns 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const key = newKey();
      await handle(key);
      await expect(
        runner.run((tx) =>
          idem.claim(tx, { key, scope: 'POST /deposits', body }),
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });

    it('leaves no key behind when the business transaction rolls back', async () => {
      const key = newKey();
      await expect(
        runner.run(async (tx) => {
          await idem.claim(tx, req(key));
          throw new Error('effect failed');
        }),
      ).rejects.toThrow('effect failed');
      expect((await handle(key)).replayed).toBe(false);
    });

    it('10 concurrent twins: one does the work, the other 9 replay its response', async () => {
      const key = newKey();
      let effects = 0;
      const twins = Array.from({ length: 10 }, () =>
        runner.run(async (tx) => {
          const claim = await idem.claim(tx, req(key));
          if (claim.kind === 'REPLAY') return claim.response;
          effects++;
          await sleep(150); // hold the key so the twins really wait on it
          await idem.complete(tx, key, created);
          return created;
        }),
      );
      const responses = await Promise.all(twins);
      expect(effects).toBe(1);
      expect(responses).toEqual(Array.from({ length: 10 }, () => created));
    });

    it('a twin that waits past lock_timeout gets 409 IDEMPOTENCY_IN_PROGRESS', async () => {
      const key = newKey();
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let claimed!: () => void;
      const isClaimed = new Promise<void>((r) => (claimed = r));

      const holder = runner.run(async (tx) => {
        await idem.claim(tx, req(key));
        claimed();
        await released;
        await idem.complete(tx, key, created);
      });
      await isClaimed;

      const impatient = new TransactionRunner(ds, {
        lockTimeoutMs: 200,
        statementTimeoutMs: 5000,
      });
      await expect(
        impatient.run((tx) => idem.claim(tx, req(key))),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS', status: 409 });

      release();
      await holder;
      expect((await handle(key)).replayed).toBe(true);
    });

    it('the database refuses a key longer than 255 characters', async () => {
      await expect(
        runner.run((tx) => idem.claim(tx, req('k'.repeat(256)))),
      ).rejects.toMatchObject({ driverError: { code: '23514' } });
    });
  });

  describe('claimWithLease (two-phase deposit create)', () => {
    const LEASE = 30;
    const deposit = () => ({ type: 'DEPOSIT', id: randomUUID() });
    const leaseScope = (key: string, b: unknown = body): ClaimRequest => ({
      key,
      scope: 'POST /deposits',
      body: b,
    });

    /** Phase 1 as deposit create runs it: claim, insert the deposit, attach it, commit. */
    const phase1 = async (key: string) => {
      const resource = deposit();
      const claim = await runner.run(async (tx) => {
        const c = await idem.claimWithLease(tx, leaseScope(key), LEASE);
        if (c.kind === 'NEW') await idem.attachResource(tx, key, resource);
        return c;
      });
      return { claim, resource };
    };
    const retry = (key: string, b: unknown = body) =>
      runner.run((tx) => idem.claimWithLease(tx, leaseScope(key, b), LEASE));

    it('a twin within the lease gets IN_PROGRESS', async () => {
      const key = newKey();
      expect((await phase1(key)).claim).toEqual({ kind: 'NEW' });
      expect(await retry(key)).toEqual({ kind: 'IN_PROGRESS' });
    });

    it('after the lease is released, a retry resumes the same record with a new lease', async () => {
      const key = newKey();
      const { resource } = await phase1(key);
      await runner.run((tx) => idem.releaseLease(tx, key));

      expect(await retry(key)).toEqual({ kind: 'RESUME', resource });
      expect(await retry(key)).toEqual({ kind: 'IN_PROGRESS' });
    });

    it('after the lease expires (the attempt died), a retry resumes', async () => {
      const key = newKey();
      const { resource } = await phase1(key);
      await ds.query(
        `UPDATE idempotency_keys SET locked_until = now() - interval '1 second' WHERE key = $1`,
        [key],
      );
      expect(await retry(key)).toEqual({ kind: 'RESUME', resource });
    });

    it('once completed, a retry replays the stored response', async () => {
      const key = newKey();
      const { resource } = await phase1(key);
      const response = {
        status: 201,
        body: { depositId: resource.id, status: 'PENDING' },
      };
      await runner.run((tx) => idem.complete(tx, key, response, resource));
      expect(await retry(key)).toEqual({ kind: 'REPLAY', response });
    });

    it('a different body is still 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const key = newKey();
      await phase1(key);
      await expect(retry(key, { ...body, amount: '1' })).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    });
  });
});
