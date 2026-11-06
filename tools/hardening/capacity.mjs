// Capacity test: the highest request rate each scenario sustains within an SLO. Run from the project root with the stack up
// (simulator in `off` mode so provider chaos does not blur the numbers):
//   SIM_CHAOS=off docker compose up -d --build --wait
//   node tools/hardening/capacity.mjs [scenario ...] [--start=20] [--factor=1.5] [--max=3000] [--duration=20] [--slo-p95=500] [--max-error=0.01] [--refine=2] [--out=file.json]
// Scenarios: reads, withdraw, transfer, hot, adjust, deposit, mixed (default: all but mixed).
//
// Open loop: requests are started at a fixed rate whatever the server does, and each latency is measured from the moment the
// request was due, not from when it was sent. A closed loop (N clients waiting on each other) hides saturation by slowing down
// with the server; an open loop shows it as growing latency and errors.
//
// For each scenario the rate starts at --start and grows by --factor per step. A step passes when, over --duration seconds:
//   - at least (1 - max-error) of the requests got the expected status,
//   - p95 latency is at most --slo-p95 ms,
//   - the achieved rate is at least 95 % of the target (the client could start and finish them).
// The first failing step ends the ramp; --refine bisects between the last pass and the first failure.
// After each scenario it checks GET /internal/invariants, so the limit is also shown to be a correct one.
// While each step runs it samples `docker stats` and PostgreSQL lock waits, which name the component that saturated.
import { exec, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? 'true'];
  }),
);
const ALL = ['reads', 'withdraw', 'transfer', 'hot', 'adjust', 'deposit'];
const chosen = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const SCENARIOS = chosen.length ? chosen : ALL;
const START = Number(args.start ?? 20);
const FACTOR = Number(args.factor ?? 1.5);
const MAX = Number(args.max ?? 3000);
const DURATION = Number(args.duration ?? 20);
const SLO_P95 = Number(args['slo-p95'] ?? 500);
const MAX_ERROR = Number(args['max-error'] ?? 0.01);
const REFINE = Number(args.refine ?? 2);
const MAX_IN_FLIGHT = Number(args['max-in-flight'] ?? 5000);
const REQUEST_TIMEOUT_MS = 10000;

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const KEY = process.env.INTERNAL_API_KEY ? { 'x-internal-api-key': process.env.INTERNAL_API_KEY } : {};
const PG_USER = process.env.POSTGRES_USER ?? 'wallet';
const PG_DB = process.env.POSTGRES_DB ?? 'wallet';
const IBAN = 'IR330566736841214070501510';
const RUN = randomUUID().slice(0, 6);
const USERS = Number(args.users ?? 300);
const say = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const s of SCENARIOS) {
  if (![...ALL, 'mixed'].includes(s)) {
    say(`unknown scenario "${s}"; choose from ${[...ALL, 'mixed'].join(', ')}`);
    process.exit(2);
  }
}

function psql(sql) {
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', PG_USER, '-d', PG_DB, '-At', '-F', '|', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout.trim();
}

const run = (cmd) => new Promise((resolve) => exec(cmd, { encoding: 'utf8', timeout: 15000 }, (err, out) => resolve(err ? '' : out)));

/** CPU per container and the number of PostgreSQL sessions waiting on a lock, sampled once. */
async function sample() {
  const [stats, locks] = await Promise.all([
    run('docker stats --no-stream --format "{{.Name}} {{.CPUPerc}}"'),
    run(`docker compose exec -T postgres psql -U ${PG_USER} -d ${PG_DB} -At -c "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'"`),
  ]);
  const cpu = {};
  for (const line of stats.trim().split('\n')) {
    const [name, pct] = line.trim().split(/\s+/);
    if (name?.startsWith('wallet-') && pct) cpu[name.replace(/^wallet-/, '')] = Number.parseInt(pct, 10);
  }
  return { cpu, lockWaits: Number.parseInt(locks.trim() || '0', 10) };
}

async function call(method, path, body, idempotencyKey) {
  const headers = { 'content-type': 'application/json', ...KEY };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  try {
    const res = await fetch(APP + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await res.text();
    return { status: res.status, text };
  } catch (e) {
    return { status: 0, text: String(e?.name ?? e) };
  }
}

const post = (path, body) => call('POST', path, body, `cap-${RUN}-${randomUUID()}`);
const pick = (n) => Math.floor(Math.random() * n);
const user = (i) => `cap-${RUN}-u${i}`;
const HOT = `cap-${RUN}-hot`;

/** Each scenario: one request, and the status that counts as success. */
const scenario = {
  reads: { expect: 200, fire: () => (Math.random() < 0.5 ? call('GET', `/wallets/${user(pick(USERS))}`) : call('GET', `/wallets/${user(pick(USERS))}/ledger?limit=20`)) },
  withdraw: { expect: 201, fire: () => post('/withdrawals', { userId: user(pick(USERS)), currency: 'IRT', amount: '100000', destination: IBAN }) },
  transfer: {
    expect: 201,
    fire: () => {
      const a = pick(USERS);
      const b = (a + 1 + pick(USERS - 1)) % USERS;
      return post('/transfers', { fromUserId: user(a), toUserId: user(b), currency: 'IRT', amount: '1000' });
    },
  },
  hot: { expect: 201, fire: () => post('/transfers', { fromUserId: HOT, toUserId: user(pick(USERS)), currency: 'IRT', amount: '1000' }) },
  adjust: { expect: 201, fire: () => post('/internal/adjustments', { userId: user(pick(USERS)), currency: 'IRT', amount: '1', reason: 'capacity test' }) },
  deposit: { expect: 201, fire: () => post('/deposits', { userId: user(pick(USERS)), amount: '10000' }) },
};
scenario.mixed = {
  expect: null,
  fire: () => {
    const r = Math.random();
    const s = r < 0.6 ? 'reads' : r < 0.8 ? 'withdraw' : r < 0.9 ? 'transfer' : 'deposit';
    return scenario[s].fire().then((res) => ({ ...res, expected: scenario[s].expect }));
  },
};

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);

/** Starts `rate` requests per second for DURATION seconds; latency counts from when each request was due. */
async function step(name, rate) {
  const s = scenario[name];
  const total = Math.round(rate * DURATION);
  const latencies = [];
  const statuses = {};
  let ok = 0;
  let launched = 0;
  let dropped = 0;
  let inFlight = 0;
  let maxTickLag = 0;
  const pending = [];
  const t0 = performance.now();
  let lastTick = t0;
  const samples = [];
  const sampler = (async () => {
    await sleep((DURATION * 1000) / 2);
    samples.push(await sample());
  })();

  while (launched + dropped < total) {
    const now = performance.now();
    maxTickLag = Math.max(maxTickLag, now - lastTick - 5);
    lastTick = now;
    const due = Math.min(total, Math.floor(((now - t0) / 1000) * rate)) - launched - dropped;
    for (let i = 0; i < due; i++) {
      const dueAt = t0 + ((launched + dropped) * 1000) / rate;
      if (inFlight >= MAX_IN_FLIGHT) {
        dropped++;
        continue;
      }
      launched++;
      inFlight++;
      pending.push(
        s.fire().then((res) => {
          inFlight--;
          const expected = res.expected ?? s.expect;
          statuses[res.status] = (statuses[res.status] ?? 0) + 1;
          if (res.status === expected) {
            ok++;
            latencies.push(performance.now() - dueAt);
          }
        }),
      );
    }
    await sleep(5);
  }
  await Promise.all(pending);
  await sampler;
  const elapsed = (performance.now() - t0) / 1000;
  latencies.sort((a, b) => a - b);
  const okRatio = total ? ok / total : 0;
  const achieved = ok / Math.max(elapsed, DURATION);
  const p95 = pct(latencies, 0.95);
  const reasons = [];
  if (okRatio < 1 - MAX_ERROR) reasons.push(`errors ${((1 - okRatio) * 100).toFixed(1)}%`);
  if (p95 > SLO_P95) reasons.push(`p95 ${p95.toFixed(0)}ms > ${SLO_P95}ms`);
  if (achieved < rate * 0.95) reasons.push(`achieved ${achieved.toFixed(0)}/s < 95% of ${rate}/s`);
  const result = {
    rate,
    achieved: Math.round(achieved),
    okRatio,
    p50: Math.round(pct(latencies, 0.5)),
    p95: Math.round(p95),
    p99: Math.round(pct(latencies, 0.99)),
    statuses,
    dropped,
    clientLagMs: Math.round(maxTickLag),
    sample: samples[0] ?? null,
    pass: reasons.length === 0,
    reasons,
  };
  const cpu = result.sample ? Object.entries(result.sample.cpu).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}%`).join(', ') : 'n/a';
  say(
    `  ${String(rate).padStart(5)}/s → ${String(result.achieved).padStart(5)}/s ok ${(okRatio * 100).toFixed(1).padStart(5)}% · p50 ${String(result.p50).padStart(5)} · p95 ${String(result.p95).padStart(5)} · p99 ${String(result.p99).padStart(5)} ms · lock waits ${result.sample?.lockWaits ?? '?'} · top CPU ${cpu} · ${result.pass ? 'PASS' : 'FAIL: ' + reasons.join('; ')}`,
  );
  if (result.clientLagMs > 100) say(`         warning: the load generator lagged ${result.clientLagMs} ms; this step may measure the client, not the service`);
  if (dropped) say(`         warning: ${dropped} requests not started (more than ${MAX_IN_FLIGHT} in flight)`);
  return result;
}

async function invariantsOk() {
  const r = await call('GET', '/internal/invariants');
  try {
    return JSON.parse(r.text).ok === true;
  } catch {
    return false;
  }
}

async function seed() {
  say(`seeding ${USERS} users with 300,000,000 toman each and one hot sender (run ${RUN})`);
  const jobs = Array.from({ length: USERS }, (_, i) => () => post('/internal/adjustments', { userId: user(i), currency: 'IRT', amount: '300000000', reason: 'capacity seed' }));
  jobs.push(() => post('/internal/adjustments', { userId: HOT, currency: 'IRT', amount: '1000000000000', reason: 'capacity seed' }));
  let next = 0;
  let failed = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (next < jobs.length) {
      const r = await jobs[next++]();
      if (r.status !== 201) failed++;
    }
  }));
  if (failed) throw new Error(`${failed} seed adjustments failed: is the stack up, and INTERNAL_API_KEY set if the service needs it?`);
}

async function ramp(name) {
  say(`\n${name}: open loop from ${START}/s, ×${FACTOR} per step, ${DURATION}s per step, SLO p95 ≤ ${SLO_P95} ms, errors ≤ ${MAX_ERROR * 100}%`);
  const steps = [];
  let rate = START;
  let lastPass = null;
  let firstFail = null;
  while (rate <= MAX) {
    const r = await step(name, rate);
    steps.push(r);
    if (!r.pass) {
      firstFail = r;
      break;
    }
    lastPass = r;
    rate = Math.round(rate * FACTOR);
    await sleep(3000);
  }
  for (let i = 0; i < REFINE && lastPass && firstFail; i++) {
    const mid = Math.round((lastPass.rate + firstFail.rate) / 2);
    if (mid === lastPass.rate || mid === firstFail.rate) break;
    await sleep(3000);
    const r = await step(name, mid);
    steps.push(r);
    if (r.pass) lastPass = r;
    else firstFail = r;
  }
  const consistent = await invariantsOk();
  const verdict = lastPass
    ? `sustains ${lastPass.rate}/s (p95 ${lastPass.p95} ms)${firstFail ? `; fails at ${firstFail.rate}/s: ${firstFail.reasons.join('; ')}` : `; no failure up to --max=${MAX}`}`
    : `fails already at ${START}/s: ${firstFail?.reasons.join('; ')}`;
  say(`  ${name}: ${verdict} · invariants ${consistent ? 'OK' : 'BROKEN'}`);
  return { scenario: name, sustained: lastPass?.rate ?? 0, firstFail: firstFail?.rate ?? null, invariantsOk: consistent, steps };
}

const before = psql(`SELECT count(*) FROM outbox WHERE published_at IS NULL`);
say(`capacity ${RUN}: ${APP}, scenarios ${SCENARIOS.join(', ')}; unsent outbox rows before: ${before}`);
await seed();
const results = [];
for (const name of SCENARIOS) results.push(await ramp(name));

const backlog = psql(`SELECT count(*) FROM outbox WHERE published_at IS NULL`);
const open = psql(`SELECT count(*) FROM withdrawals WHERE status IN ('PENDING','SUBMITTING','PROCESSING')`);
say('\nsummary (sustained = highest rate that met the SLO)');
for (const r of results) say(`  ${r.scenario.padEnd(9)} ${String(r.sustained).padStart(6)}/s   first failure ${r.firstFail ?? '-'}   invariants ${r.invariantsOk ? 'OK' : 'BROKEN'}`);
say(`after the run: ${backlog} unsent outbox rows, ${open} withdrawals not yet final (the asynchronous side catches up after the load; see bench.mjs phase 4)`);
if (args.out) {
  writeFileSync(args.out, JSON.stringify({ run: RUN, app: APP, slo: { p95: SLO_P95, maxError: MAX_ERROR }, durationSeconds: DURATION, results }, null, 2));
  say(`written to ${args.out}`);
}
process.exit(results.every((r) => r.invariantsOk) ? 0 : 1);
