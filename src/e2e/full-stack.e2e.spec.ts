import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const base = process.env.E2E_BASE_URL?.replace(/\/$/, '');
const simulator = (process.env.E2E_SIMULATOR_URL ?? '').replace(/\/$/, '');
const internalKey = process.env.INTERNAL_API_KEY;
const e2e = base && simulator ? describe : describe.skip;

const IBAN = 'IR330566736841214070501510';
const STEP_TIMEOUT_MS = 150_000;
const PAYOUT_TIMEOUT_MS = 12 * 60_000;

interface Reply<T = Record<string, unknown>> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

interface DepositBody {
  depositId: string;
  status: string;
  paymentUrl: string;
  creditedAmount: string | null;
}

interface WithdrawalBody {
  withdrawalId: string;
  status: string;
  returnedAt: string | null;
}

interface WalletBody {
  balances: { currency: string; available: string; frozen: string }[];
}

interface LedgerBody {
  items: { type: string; reference: { id: string } }[];
}

/**
 * One request through the public entry point. A transport failure (the stack is allowed to restart a container) is reported as status 0.
 */
async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply<T>> {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(internalKey ? { 'x-internal-api-key': internalKey } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      body: (text ? JSON.parse(text) : {}) as T,
    };
  } catch {
    return { status: 0, headers: new Headers(), body: {} as T };
  }
}

/**
 * Retries one request, always with the same Idempotency-Key, the way a real client does: transport failures, 5xx and 409 (the twin is still running) are retried, anything else is final.
 */
async function post<T>(
  path: string,
  body: unknown,
  key: string,
): Promise<Reply<T>> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let last: Reply<T>;
  do {
    last = await call<T>('POST', path, body, { 'idempotency-key': key });
    if (last.status !== 0 && last.status !== 409 && last.status < 500) {
      return last;
    }
    await sleep(500);
  } while (Date.now() < deadline);
  return last;
}

/**
 * Polls `read` until `done` accepts what it returns, and fails with the last value if that does not happen in time.
 */
async function until<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (done(last)) return last;
    await sleep(2000);
  } while (Date.now() < deadline);
  throw new Error(
    `${what}: not reached in time; last: ${JSON.stringify(last)}`,
  );
}

/**
 * The simulator's "pay" button: the payer completes the payment on the PSP's page. Retried because the simulator may be in a chaos mode.
 */
async function payOnPsp(paymentUrl: string): Promise<void> {
  const token = new URL(paymentUrl).pathname.split('/').pop() as string;
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = await fetch(`${simulator}/psp/pay/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"result":"success"}',
      signal: AbortSignal.timeout(8000),
    }).then(
      (res) => res.status,
      () => 0,
    );
    if (status === 200 || status === 409) return;
    await sleep(500);
  }
  throw new Error(`paying ${token} on the PSP never succeeded`);
}

const irt = (wallet: WalletBody) => {
  const b = wallet.balances.find((x) => x.currency === 'IRT');
  return { available: b?.available ?? '0', frozen: b?.frozen ?? '0' };
};

/**
 * One journey through the whole running stack, as a client sees it: every request goes through nginx to the api replicas, and everything after the 201 is done by the workers, RabbitMQ and the simulator.
 * Skipped unless `E2E_BASE_URL` and `E2E_SIMULATOR_URL` are set, which the compose `test` service does.
 * Duration: about a minute, but the simulator's payouts are bimodal in its default chaos mode (measured over 30: p50 28 s, p90 494 s, max 518 s), so about one run in ten waits around 8 minutes for the payout. The wait is bounded at 12 minutes, which is longer than any payout seen (PAY-08).
 */
e2e(`end to end on the full stack (${base ?? ''})`, () => {
  jest.setTimeout(PAYOUT_TIMEOUT_MS + 6 * STEP_TIMEOUT_MS);

  const userId = `e2e_${randomUUID().slice(0, 12)}`;
  const depositKey = `e2e-dep-${randomUUID()}`;
  const withdrawalKey = `e2e-wd-${randomUUID()}`;
  let deposit: DepositBody;
  let withdrawal: WithdrawalBody;

  it('the stack is ready: database and broker reachable through nginx', async () => {
    const ready = await until(
      '/ready',
      () => call('GET', '/ready'),
      (r) => r.status === 200,
    );
    expect(ready.status).toBe(200);
  });

  it('deposit: created behind the PSP, paid on the PSP, credited by the workers', async () => {
    const created = await post<DepositBody>(
      '/deposits',
      { userId, amount: '150000' },
      depositKey,
    );
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('PENDING');
    deposit = created.body;

    const replay = await post<DepositBody>(
      '/deposits',
      { userId, amount: '150000' },
      depositKey,
    );
    expect(replay.body.depositId).toBe(deposit.depositId);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');

    await payOnPsp(deposit.paymentUrl);
    const done = await until(
      'deposit',
      () => call<DepositBody>('GET', `/deposits/${deposit.depositId}`),
      (r) => ['SUCCEEDED', 'FAILED'].includes(r.body.status),
    );
    expect(done.body.status).toBe('SUCCEEDED');
    expect(done.body.creditedAmount).toBe('150000');

    const wallet = await call<WalletBody>('GET', `/wallets/${userId}`);
    expect(irt(wallet.body)).toEqual({ available: '150000', frozen: '0' });
  });

  it('withdrawal: frozen at once, paid out by the workers through the payout service', async () => {
    const created = await post<WithdrawalBody>(
      '/withdrawals',
      { userId, currency: 'IRT', amount: '100000', destination: IBAN },
      withdrawalKey,
    );
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('PENDING');
    withdrawal = created.body;

    const wallet = await call<WalletBody>('GET', `/wallets/${userId}`);
    const now = irt(wallet.body);
    expect(now.available).toBe('50000');
    expect(['100000', '0']).toContain(now.frozen);

    const done = await until(
      'withdrawal',
      () =>
        call<WithdrawalBody>('GET', `/withdrawals/${withdrawal.withdrawalId}`),
      (r) => ['SUCCEEDED', 'FAILED'].includes(r.body.status),
      PAYOUT_TIMEOUT_MS,
    );
    expect(done.body.status).toBe('SUCCEEDED');
  });

  it('the books agree with what happened: frozen money released, history complete', async () => {
    let returned = false;
    let wallet: WalletBody = { balances: [] };
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await call<WithdrawalBody>(
        'GET',
        `/withdrawals/${withdrawal.withdrawalId}`,
      );
      wallet = (await call<WalletBody>('GET', `/wallets/${userId}`)).body;
      const after = await call<WithdrawalBody>(
        'GET',
        `/withdrawals/${withdrawal.withdrawalId}`,
      );
      returned = after.body.returnedAt !== null;
      if ((before.body.returnedAt !== null) === returned) break;
    }
    expect(irt(wallet)).toEqual({
      available: returned ? '150000' : '50000',
      frozen: '0',
    });

    const history = await call<LedgerBody>('GET', `/wallets/${userId}/ledger`);
    const kinds = history.body.items.map((i) => i.type);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'DEPOSIT_CREDIT',
        'WITHDRAWAL_FREEZE',
        'WITHDRAWAL_SETTLE',
      ]),
    );
    const refs = history.body.items.map((i) => i.reference.id);
    expect(refs).toEqual(
      expect.arrayContaining([deposit.depositId, withdrawal.withdrawalId]),
    );
  });

  it('the invariants hold on the whole database', async () => {
    const report = await until(
      '/internal/invariants',
      () =>
        call<{ ok: boolean; checks: { name: string; ok: boolean }[] }>(
          'GET',
          '/internal/invariants',
        ),
      (r) => r.status === 200,
    );
    expect(report.body.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.body.ok).toBe(true);
  });
});
