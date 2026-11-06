// How many outbox rows per second do the relays publish? Builds a backlog while the workers are stopped, then starts one worker and then the second.
//   node tools/hardening/relay-bench.mjs [rows]
// Run from the project root with the stack up. The backlog is balance-changed events, from adjustments of existing users.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const ROWS = Number(process.argv[2] ?? 6000);
const KEY = process.env.INTERNAL_API_KEY ? { 'x-internal-api-key': process.env.INTERNAL_API_KEY } : {};
const run = randomUUID().slice(0, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const psql = (sql) => docker('compose', 'exec', '-T', 'postgres', 'psql', '-U', 'wallet', '-d', 'wallet', '-At', '-c', sql).stdout.trim();
const unsent = () => Number(psql('SELECT count(*) FROM outbox WHERE published_at IS NULL'));

async function adjust(user, key) {
  const res = await fetch(`${APP}/internal/adjustments`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, ...KEY }, body: JSON.stringify({ userId: user, currency: 'IRT', amount: '1000', reason: 'relay bench' }), signal: AbortSignal.timeout(30000) });
  await res.text();
  return res.status;
}

/** Waits for the backlog to start shrinking (the worker has booted), then reports the rate over the next `seconds`. */
async function drainRate(label, seconds) {
  const before = unsent();
  while (unsent() >= before) await sleep(250);
  const start = unsent();
  const t0 = Date.now();
  let last = start;
  while ((Date.now() - t0) / 1000 < seconds && last > 0) {
    await sleep(1000);
    last = unsent();
  }
  const s = (Date.now() - t0) / 1000;
  console.log(`${label}: ${((start - last) / s).toFixed(0)} rows/s published (${start - last} rows in ${s.toFixed(1)}s, ${last} left)`);
  return last;
}

const users = Array.from({ length: 200 }, (_, i) => `rb_${run}_${i}`);
await Promise.all(users.map((u, i) => adjust(u, `rb-seed-${run}-${i}`)));
while (unsent() > 0) await sleep(1000);
console.log(`seeded ${users.length} users, outbox empty`);

docker('stop', 'wallet-worker-1', 'wallet-worker-2');
console.log('workers stopped; building the backlog');
let n = 0;
let failed = 0;
await Promise.all(Array.from({ length: 32 }, async () => {
  while (n < ROWS) {
    const i = n++;
    if ((await adjust(users[i % users.length], `rb-${run}-${i}`)) !== 201) failed++;
  }
}));
console.log(`backlog: ${unsent()} unsent rows (${failed} requests refused)`);

docker('start', 'wallet-worker-1');
const afterOne = await drainRate('one relay (worker-1)', 20);
docker('start', 'wallet-worker-2');
await drainRate('two relays (worker-1 and worker-2)', 20);
while (unsent() > 0) await sleep(1000);
console.log(`done, outbox empty again (${afterOne} were left when the second worker joined)`);
