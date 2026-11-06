// Throughput probe: how much one running stack takes in, and what limits it first. Run from the project root with the stack up
// (simulator in `off` mode so provider chaos does not blur the numbers):
//   SIM_CHAOS=off docker compose up -d --wait
//   node tools/hardening/bench.mjs [seconds] [concurrency]
// Phases, each a closed loop of `concurrency` clients for `seconds`:
//   1  adjustments of existing users: every journal also writes the one OPS_ADJUSTMENTS system account
//   2  withdrawal requests, a different user each: user rows only (accounts, daily usage), plus the outbox
//   3  withdrawal requests of ONE user: every request waits for the same row locks
//   4  after the load: how long the outbox, the job queues and the payout pipeline take to drain
// PHASES=1 (or 12, 23, ...) runs only some of them; phase 4 follows whatever was loaded.
// Every number it prints is a measurement of this machine; read them as ratios, not as promises.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const SECONDS = Number(process.argv[2] ?? 15);
const CONCURRENCY = Number(process.argv[3] ?? 32);
const PHASES = process.env.PHASES ?? '1234';
const IBAN = 'IR330566736841214070501510';
const KEY = process.env.INTERNAL_API_KEY ? { 'x-internal-api-key': process.env.INTERNAL_API_KEY } : {};
const run = randomUUID().slice(0, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(...a);

const psql = (sql) => {
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'wallet', '-d', 'wallet', '-At', '-F', '|', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('|'));
};

async function post(path, body, key) {
  const t0 = performance.now();
  try {
    const res = await fetch(APP + path, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, ...KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    await res.text();
    return { status: res.status, ms: performance.now() - t0 };
  } catch {
    return { status: 0, ms: performance.now() - t0 };
  }
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);

/** `make(i)` returns [path, body, key]; clients keep going until the clock runs out. */
async function load(label, make) {
  const results = [];
  const end = performance.now() + SECONDS * 1000;
  let i = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (performance.now() < end) {
      const [path, body, key] = make(i++);
      results.push(await post(path, body, key));
    }
  }));
  const elapsed = (performance.now() - t0) / 1000;
  const ok = results.filter((r) => r.status === 201 || r.status === 200);
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
  const byStatus = results.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
  say(`${label}: ${(ok.length / elapsed).toFixed(0)} req/s ok (${ok.length} in ${elapsed.toFixed(1)}s) · p50 ${pct(ms, 0.5).toFixed(0)} ms · p95 ${pct(ms, 0.95).toFixed(0)} ms · p99 ${pct(ms, 0.99).toFixed(0)} ms · statuses ${JSON.stringify(byStatus)}`);
  return { label, rate: ok.length / elapsed, p50: pct(ms, 0.5), p95: pct(ms, 0.95), count: ok.length };
}

async function seed(users, amount) {
  let n = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (n < users.length) {
      const u = users[n++];
      const r = await post('/internal/adjustments', { userId: u, currency: 'IRT', amount, reason: 'bench seed' }, `seed-${u}`);
      if (r.status !== 201 && r.status !== 200) throw new Error(`seed ${u} answered ${r.status}`);
    }
  }));
}

async function pending() {
  const [[unsent]] = psql(`SELECT count(*) FROM outbox WHERE published_at IS NULL`);
  const [[open]] = psql(`SELECT count(*) FROM withdrawals WHERE status IN ('PENDING','SUBMITTING')`);
  const [[processing]] = psql(`SELECT count(*) FROM withdrawals WHERE status = 'PROCESSING'`);
  return { unsent: Number(unsent), toSubmit: Number(open), processing: Number(processing) };
}

say(`bench ${run}: ${SECONDS}s per phase, ${CONCURRENCY} concurrent clients, ${APP}`);
const before = psql(`SELECT (SELECT count(*) FROM journals), (SELECT count(*) FROM outbox), (SELECT count(*) FROM outbox WHERE published_at IS NULL)`)[0];
say(`database before: ${before[0]} journals, ${before[1]} outbox rows, ${before[2]} unsent`);

let phase1;
let phase2;
let phase3;
if (PHASES.includes('1')) {
  const adjusted = Array.from({ length: 400 }, (_, i) => `bn1_${run}_${i}`);
  await seed(adjusted, '1000');
  phase1 = await load('1 adjustments, existing users   ', (i) => ['/internal/adjustments', { userId: adjusted[i % adjusted.length], currency: 'IRT', amount: '1000', reason: 'bench' }, `b1-${run}-${i}`]);
}
if (PHASES.includes('2')) {
  const users = Array.from({ length: 400 }, (_, i) => `bn2_${run}_${i}`);
  await seed(users, '100000000');
  phase2 = await load('2 withdrawals, distinct users   ', (i) => ['/withdrawals', { userId: users[i % users.length], currency: 'IRT', amount: '100000', destination: IBAN }, `b2-${run}-${i}`]);
}
if (PHASES.includes('3')) {
  const hot = `bn3_${run}`;
  await seed([hot], '190000000');
  phase3 = await load('3 withdrawals, one hot user     ', (i) => ['/withdrawals', { userId: hot, currency: 'IRT', amount: '100000', destination: IBAN }, `b3-${run}-${i}`]);
}

const loadEnded = Date.now();
say('after the load, still to do:', JSON.stringify(await pending()));
const samples = [];
for (;;) {
  const p = await pending();
  samples.push({ t: (Date.now() - loadEnded) / 1000, ...p });
  if (p.unsent === 0 && p.toSubmit === 0) break;
  if (Date.now() - loadEnded > 600000) break;
  await sleep(1000);
}
const last = samples[samples.length - 1];
const first = samples[0];
say(`4 drain: outbox empty and every withdrawal submitted ${last.t.toFixed(1)}s after the load stopped (started with ${first.unsent} unsent, ${first.toSubmit} not yet submitted)`);
const unsentZero = samples.find((s) => s.unsent === 0);
const submittedAll = samples.find((s) => s.toSubmit === 0);
say(`   outbox empty after ${unsentZero ? unsentZero.t.toFixed(1) : '>600'}s; all withdrawals submitted after ${submittedAll ? submittedAll.t.toFixed(1) : '>600'}s`);
const submitted = (phase2?.count ?? 0) + (phase3?.count ?? 0);
if (PHASES.length && submittedAll && submittedAll.t > 0) say(`   payout submit rate while draining: ~${(first.toSubmit / submittedAll.t).toFixed(0)} withdrawals/s (${first.toSubmit} to submit)`);

const [[journals]] = psql(`SELECT count(*) FROM journals`);
const [[lag]] = psql(`SELECT coalesce(round(extract(epoch FROM max(now() - created_at))::numeric, 1)::text, '0') FROM outbox WHERE published_at IS NULL`);
say(`database after: ${journals} journals (+${Number(journals) - Number(before[0])}), oldest unsent outbox row ${lag}s, ${submitted} withdrawals accepted in phases 2-3`);
say(`summary ${JSON.stringify({ phase1, phase2, phase3 })}`);
