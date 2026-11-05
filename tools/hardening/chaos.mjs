// Reliability harness: real traffic through nginx while containers are killed or restarted. Run from the project root with the stack up:
//   node tools/hardening/chaos.mjs A B C D E F
//   A  api SIGKILLed mid POST /deposits burst, hostile simulator     D  RabbitMQ SIGKILLed twice under load
//   B  workers SIGKILLed while paid deposits sync                    E  out-of-order and forged webhooks and callbacks
//   C  Postgres restarted then SIGKILLed under deposit + withdrawal load   F  simulator restarted (provider state lost)
//   H  USDT withdrawals end to end: fee, CRYPTO payout, one daily cap shared with IRT
//   G  money races: parallel withdrawals against one balance and against the daily limit
// Clients retry the way real ones do; afterwards it checks one deposit/withdrawal per key, no double credit, invariants, eventual completion.
// `docker kill` counts as a manual stop (the restart policy ignores it), so a killed container is started again after a short delay.
import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';

const ROOT = process.cwd();
const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const SIM = process.env.SIM_URL ?? 'http://127.0.0.1:8080';
const IBAN = 'IR330566736841214070501510';
const SECRET = process.env.PAYOUT_WEBHOOK_SECRET ?? 'hamtapay-sim-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = Math.random().toString(36).slice(2, 6);
const problems = [];
const say = (...a) => console.log(...a);
const problem = (m) => { problems.push(m); say('  PROBLEM:', m); };

const docker = (...args) => spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env } });
const compose = (...args) => docker('compose', ...args);
const psql = (sql) => {
  const r = compose('exec', '-T', 'postgres', 'psql', '-U', 'wallet', '-d', 'wallet', '-At', '-F', '|', '-c', sql);
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('|'));
};

async function call(method, path, body, headers = {}) {
  try {
    const res = await fetch(APP + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: res.status, body: j, text: t };
  } catch (e) { return { status: 0, body: null, text: String(e.cause?.code ?? e.message) }; }
}
/** A client that retries one request (same key) until it gets an answer that is final for it. */
async function untilDone(method, path, body, headers, ok = [201, 200], maxMs = 150000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < maxMs) {
    last = await call(method, path, body, headers);
    if (ok.includes(last.status)) return last;
    if (last.status >= 400 && last.status < 500 && ![409, 408, 425, 429].includes(last.status)) return last;
    await sleep(300);
  }
  return last;
}
const statusOf = (name) => docker('inspect', '-f', '{{.State.Health.Status}}', name).stdout.trim();
async function waitHealthy(maxS = 150) {
  const names = ['wallet-postgres-1', 'wallet-rabbitmq-1', 'wallet-simulator-1', 'wallet-api-1', 'wallet-api-2', 'wallet-worker-1', 'wallet-worker-2', 'wallet-app-1'];
  const t0 = Date.now();
  while (Date.now() - t0 < maxS * 1000) {
    if (names.every((n) => statusOf(n) === 'healthy')) return (Date.now() - t0) / 1000;
    await sleep(1500);
  }
  problem(`not all containers healthy after ${maxS}s: ${names.map((n) => `${n}=${statusOf(n)}`).join(' ')}`);
  return null;
}
const restartCounts = () => Object.fromEntries(['wallet-api-1', 'wallet-api-2', 'wallet-worker-1', 'wallet-worker-2', 'wallet-postgres-1', 'wallet-rabbitmq-1', 'wallet-app-1'].map((n) => [n, parseInt(docker('inspect', '-f', '{{.RestartCount}}', n).stdout.trim(), 10)]));

async function setSimulator(mode) {
  const r = spawnSync('docker', ['compose', 'up', '-d', '--wait', '--force-recreate', 'simulator'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, SIM_CHAOS: mode } });
  if (r.status !== 0) problem(`simulator ${mode} failed: ${r.stderr.slice(-300)}`);
  await sleep(1000);
}
async function pay(token) {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${SIM}/psp/pay/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"result":"success"}', signal: AbortSignal.timeout(8000) });
      if ([200, 409].includes(r.status)) return r.status;
      if (r.status === 404) return 404;
    } catch {}
    await sleep(300);
  }
  return 'FAILED';
}

/** Many clients at once; each retries its own key until it is answered. */
async function depositFlow(tag, n, { payIt = true } = {}) {
  const items = Array.from({ length: n }, (_, i) => ({ userId: `ch${tag}_${run}_${i}`, key: `ch${tag}-${run}-${i}` }));
  await Promise.all(items.map(async (d) => {
    const r = await untilDone('POST', '/deposits', { userId: d.userId, amount: '1000' }, { 'idempotency-key': d.key });
    d.create = r;
    if (r.status !== 201) { problem(`create ${d.key} ended ${r.status} ${r.text.slice(0, 100)}`); return; }
    d.id = r.body.depositId; d.url = r.body.paymentUrl;
    if (payIt && r.body.status === 'PENDING') d.paid = await pay(d.url.split('/').pop());
  }));
  return items;
}
async function finals(items, what, maxS = 240) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxS * 1000) {
    let open = 0;
    for (const d of items) {
      if (!d.id || d.final) continue;
      const r = await call('GET', `/${what}/${d.id}`);
      if (r.status === 200 && ['SUCCEEDED', 'FAILED'].includes(r.body.status)) d.final = r.body; else open++;
    }
    if (open === 0) return (Date.now() - t0) / 1000;
    await sleep(3000);
  }
  return null;
}
/** `docker kill` marks a container as manually stopped, so Docker's restart policy ignores it: start it again, as an orchestrator would. */
const crash = async (name, downMs) => { docker('kill', '-s', 'KILL', name); await sleep(downMs); docker('start', name); };
const killLoop = async (names, everyMs, forMs, downMs = 1500) => {
  const t0 = Date.now(); let i = 0;
  while (Date.now() - t0 < forMs) {
    const name = names[i++ % names.length];
    await crash(name, downMs);
    say(`  killed + restarted ${name} at +${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await sleep(everyMs);
  }
};

async function verifyDeposits(items, label) {
  const users = items.map((d) => `'${d.userId}'`).join(',');
  const dup = psql(`SELECT user_id, count(*) FROM deposits WHERE user_id IN (${users}) GROUP BY 1 HAVING count(*) <> 1`);
  if (dup.length) problem(`${label}: users with != 1 deposit: ${JSON.stringify(dup.slice(0, 5))}`);
  const created = psql(`SELECT count(*) FROM deposits WHERE user_id IN (${users}) AND status = 'CREATED'`)[0][0];
  say(`  ${label}: deposits left CREATED: ${created}`);
  const twice = psql(`SELECT ref_id, count(*) FROM journals WHERE kind='DEPOSIT_CREDIT' AND ref_id IN (SELECT id FROM deposits WHERE user_id IN (${users})) GROUP BY 1 HAVING count(*) > 1`);
  if (twice.length) problem(`${label}: deposits credited twice: ${JSON.stringify(twice)}`);
  const dist = psql(`SELECT status || coalesce(':' || failure_reason,'') || CASE WHEN needs_review THEN '+review:' || review_reason ELSE '' END, count(*) FROM deposits WHERE user_id IN (${users}) GROUP BY 1 ORDER BY 1`);
  say(`  ${label}: outcomes`, JSON.stringify(Object.fromEntries(dist)));
  let wrong = 0;
  for (const d of items) {
    if (!d.id) continue;
    const row = psql(`SELECT status, coalesce(credited_rial::text,'') FROM deposits WHERE id='${d.id}'`)[0];
    const bal = psql(`SELECT coalesce(max(balance_minor)::text,'0') FROM accounts WHERE user_id='${d.userId}' AND kind='AVAILABLE' AND currency='IRR'`)[0][0];
    const expected = row[0] === 'SUCCEEDED' ? '10000' : '0';
    if (bal !== expected) { wrong++; problem(`${label}: ${d.userId} balance ${bal} but deposit ${row[0]}`); }
  }
  return wrong;
}
async function globalChecks(label) {
  const inv = await untilDone('GET', '/internal/invariants', undefined, {}, [200], 30000);
  if (!inv.body?.ok) problem(`${label}: invariants not ok ${inv.text.slice(0, 300)}`);
  const dead = psql(`SELECT count(*) FROM outbox WHERE published_at IS NULL AND created_at < now() - interval '2 minutes'`)[0][0];
  if (dead !== '0') problem(`${label}: ${dead} outbox rows unpublished for > 2 min`);
  const rc = restartCounts();
  say(`  ${label}: invariants ok=${inv.body?.ok}; restart counts`, JSON.stringify(rc));
  const queues = await fetch(`http://127.0.0.1:${compose('port', 'rabbitmq', '15672').stdout.trim().split(':').pop()}/api/queues`, { headers: { authorization: 'Basic ' + Buffer.from('guest:guest').toString('base64') } }).then((r) => r.json()).catch(() => []);
  const dl = queues.find((q) => q.name === 'job.dead');
  say(`  ${label}: job.dead messages: ${dl?.messages ?? '?'}; other queue depths: ${queues.filter((q) => q.name !== 'job.dead').map((q) => `${q.name}=${q.messages}`).join(' ')}`);
  if ((dl?.messages ?? 0) > 0) problem(`${label}: ${dl.messages} messages in job.dead`);
}

const scenarios = {
  async A() {
    say('A: API containers SIGKILLed mid POST /deposits burst (hostile simulator: 503s, timeouts, resets)');
    await setSimulator('hostile'); await waitHealthy();
    const killer = killLoop(['wallet-api-1', 'wallet-api-2'], 1200, 9000);
    const items = await depositFlow('A', 60, { payIt: false });
    await killer; await waitHealthy();
    say(`  created ${items.filter((d) => d.id).length}/60`);
    await verifyDeposits(items, 'A (after create)');
    await Promise.all(items.filter((d) => d.url).map(async (d) => { d.paid = await pay(d.url.split('/').pop()); }));
    const t = await finals(items.filter((d) => d.id), 'deposits');
    say(`  all final after ${t}s`); if (t === null) problem('A: deposits not final in time');
    await verifyDeposits(items, 'A (final)');
    await globalChecks('A');
    return items;
  },
  async B() {
    say('B: workers SIGKILLed repeatedly while paid deposits are being synced and callbacks flow');
    await setSimulator('default'); await waitHealthy();
    const items = await depositFlow('B', 40, { payIt: false });
    await Promise.all(items.filter((d) => d.url).map(async (d) => { d.paid = await pay(d.url.split('/').pop()); }));
    await killLoop(['wallet-worker-1', 'wallet-worker-2', 'wallet-worker-1'], 2500, 15000);
    await waitHealthy();
    const t = await finals(items.filter((d) => d.id), 'deposits');
    say(`  all final after ${t}s`); if (t === null) problem('B: deposits not final in time');
    await verifyDeposits(items, 'B'); await globalChecks('B');
  },
  async C() {
    say('C: Postgres restarted (graceful, then SIGKILL) under mixed deposit + withdrawal load');
    await setSimulator('default'); await waitHealthy();
    const users = Array.from({ length: 15 }, (_, i) => `chC_${run}_w${i}`);
    for (const u of users) await untilDone('POST', '/internal/adjustments', { userId: u, currency: 'IRT', amount: '1000000', reason: 'chaos seed' }, { 'idempotency-key': `seed-${u}` });
    const chaos = (async () => { await sleep(2500); say('  docker restart postgres'); docker('restart', 'wallet-postgres-1'); await sleep(14000); say('  docker kill postgres (SIGKILL), back after 3s'); await crash('wallet-postgres-1', 3000); })();
    const wds = users.map(async (u, i) => { const r = await untilDone('POST', '/withdrawals', { userId: u, currency: 'IRT', amount: '150000', destination: IBAN }, { 'idempotency-key': `wd-${u}` }); return { userId: u, r, id: r.body?.withdrawalId }; });
    const items = await depositFlow('C', 30);
    const w = await Promise.all(wds); await chaos; await waitHealthy(200);
    say(`  withdrawals accepted: ${w.filter((x) => x.r.status === 201).length}/15`);
    for (const x of w) if (x.r.status !== 201) problem(`C: withdrawal ${x.userId} ended ${x.r.status} ${x.r.text.slice(0, 100)}`);
    const t = await finals(items.filter((d) => d.id), 'deposits', 300);
    say(`  deposits final after ${t}s`); if (t === null) problem('C: deposits not final in time');
    await verifyDeposits(items, 'C');
    const wdup = psql(`SELECT user_id, count(*) FROM withdrawals WHERE user_id LIKE 'chC_${run}_w%' GROUP BY 1 HAVING count(*) <> 1`);
    if (wdup.length) problem(`C: users with != 1 withdrawal: ${JSON.stringify(wdup.slice(0, 5))}`);
    const wt = await finals(w.filter((x) => x.id), 'withdrawals', 420);
    say(`  withdrawals final after ${wt}s`);
    const wd = psql(`SELECT status || CASE WHEN needs_review THEN '+review:' || review_reason ELSE '' END, count(*) FROM withdrawals WHERE user_id LIKE 'chC_${run}_w%' GROUP BY 1`);
    say('  withdrawal outcomes', JSON.stringify(Object.fromEntries(wd)));
    await globalChecks('C');
  },
  async D() {
    say('D: RabbitMQ SIGKILLed twice under load (outbox + sweeper must carry everything across)');
    await setSimulator('default'); await waitHealthy();
    const items = await depositFlow('D', 40, { payIt: false });
    await Promise.all(items.filter((d) => d.url).map(async (d) => { d.paid = await pay(d.url.split('/').pop()); }));
    say('  kill rabbitmq (down 8s)'); await crash('wallet-rabbitmq-1', 8000); await waitHealthy(120);
    say('  kill rabbitmq again (down 3s)'); await crash('wallet-rabbitmq-1', 3000); await waitHealthy(120);
    const t = await finals(items.filter((d) => d.id), 'deposits', 300);
    say(`  all final after ${t}s`); if (t === null) problem('D: deposits not final in time');
    await verifyDeposits(items, 'D'); await globalChecks('D');
  },
  async E() {
    say('E: out-of-order and forged events on the live stack');
    await setSimulator('default'); await waitHealthy();
    const sign = (b) => createHmac('sha256', SECRET).update(b).digest('hex');
    const hook = (b) => call('POST', '/webhooks/payout', b, { 'x-signature': sign(b) });
    const u = `chE_${run}_u`;
    await untilDone('POST', '/internal/adjustments', { userId: u, currency: 'IRT', amount: '1000000', reason: 'chaos seed' }, { 'idempotency-key': `seed-${u}` });
    const w = await untilDone('POST', '/withdrawals', { userId: u, currency: 'IRT', amount: '150000', destination: IBAN }, { 'idempotency-key': `wd-${u}` });
    const id = w.body.withdrawalId;
    const forged = JSON.stringify({ event: 'transfer.updated', eventId: 'e1', requestId: id, status: 'FAILED', reason: 'FORGED', amount: '1500000', currency: 'IRR' });
    for (let i = 0; i < 5; i++) { const r = await hook(forged); if (r.status !== 200) problem(`E: forged-but-signed webhook answered ${r.status}`); }
    const reorder = ['RETURNED', 'PROCESSING', 'SUCCEEDED', 'ACCEPTED', 'FAILED'];
    for (const s of reorder) await hook(JSON.stringify({ requestId: id, status: s, eventId: randomUUID() }));
    await hook(JSON.stringify({ requestId: randomUUID(), status: 'SUCCEEDED' }));
    await hook('{"requestId": 5}');
    const t = await finals([{ id }], 'withdrawals', 300);
    const row = psql(`SELECT status, coalesce(failure_reason,''), needs_review FROM withdrawals WHERE id='${id}'`)[0];
    say(`  withdrawal after forged/reordered webhooks: ${row.join(' ')} (final after ${t}s)`);
    const bal = psql(`SELECT kind, balance_minor FROM accounts WHERE user_id='${u}' AND currency='IRR' ORDER BY kind`);
    say('  balances', JSON.stringify(Object.fromEntries(bal)));
    const items = await depositFlow('E', 6, { payIt: false });
    const d = items[0];
    const tok = d.url.split('/').pop();
    const cb = (body) => call('POST', `/webhooks/psp/callback/${d.id}`, body);
    await cb({ token: tok, orderId: d.id, status: 'NOK' });
    say('  pay:', await pay(tok), 'pay again:', await pay(tok));
    await cb({ token: tok, orderId: d.id, status: 'OK', amount: '999999999' });
    await cb({ token: tok, orderId: d.id, status: 'NOK' });
    await cb({ token: 'A0forged', orderId: d.id, status: 'OK' });
    await cb({ token: tok, orderId: randomUUID(), status: 'OK' });
    const unknownPay = await fetch(`${SIM}/psp/pay/A0doesnotexist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"result":"success"}' }).then((r) => r.status);
    say('  paying an unknown token at the PSP ->', unknownPay);
    for (const x of items.slice(1)) await pay(x.url.split('/').pop());
    const tf = await finals(items, 'deposits', 200);
    await verifyDeposits(items, 'E'); await globalChecks('E');
    const wrongD = items[0].final?.creditedAmount;
    say(`  deposit with a forged 999999999 callback credited: ${wrongD} toman (must be 1000)`);
    if (wrongD !== '1000') problem(`E: forged amount credited ${wrongD}`);
  },
  async H() {
    say('H: USDT withdrawals on the real stack and simulator: fee, CRYPTO payout, and one daily cap shared with IRT');
    await setSimulator('default'); await waitHealthy();
    const TRC20 = 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y79bP';
    const seed = (u, currency, amount) => untilDone('POST', '/internal/adjustments', { userId: u, currency, amount, reason: 'chaos seed' }, { 'idempotency-key': `seed-${u}-${currency}` });
    const feeRevenue = () => BigInt(psql(`SELECT balance_minor FROM accounts WHERE kind='FEE_REVENUE' AND currency='USDT' AND user_id IS NULL`)[0][0]);
    const usdtBody = (u, amount) => ({ userId: u, currency: 'USDT', amount, destination: TRC20 });

    const u = `chH_${run}_fee`;
    await seed(u, 'USDT', '10');
    const short = await call('POST', '/withdrawals', usdtBody(u, '10'), { 'idempotency-key': `h-short-${run}` });
    say(`  10 USDT with exactly 10 available: ${short.status} ${short.body?.code}`);
    if (short.status !== 422 || short.body?.code !== 'INSUFFICIENT_FUNDS') problem(`H: expected 422 INSUFFICIENT_FUNDS, got ${short.status}`);
    await untilDone('POST', '/internal/adjustments', { userId: u, currency: 'USDT', amount: '1', reason: 'chaos top-up' }, { 'idempotency-key': `seed2-${u}` });
    const feeBefore = feeRevenue();
    const ok = await untilDone('POST', '/withdrawals', usdtBody(u, '10'), { 'idempotency-key': `h-ok-${run}` });
    say(`  10 USDT with 11 available: ${ok.status}`);
    if (ok.status !== 201) { problem(`H: expected 201, got ${ok.status} ${ok.text}`); return; }
    const id = ok.body.withdrawalId;
    const frozen = psql(`SELECT balance_minor FROM accounts WHERE user_id='${u}' AND kind='FROZEN' AND currency='USDT'`)[0][0];
    say(`  frozen while open: ${frozen} micro-USDT (must be 11000000)`);
    if (frozen !== '11000000') problem(`H: frozen ${frozen}`);
    const t = await finals([{ id }], 'withdrawals', 300);
    const w = psql(`SELECT status, limit_rate_rial_per_usdt, limit_amount_rial FROM withdrawals WHERE id='${id}'`)[0];
    say(`  final after ${t}s: ${w.join(' ')} (rate rial/USDT and the rial counted, 10 USDT)`);
    if (w[0] !== 'SUCCEEDED') problem(`H: withdrawal ${w[0]}`);
    if (w[1] !== '1000000' || w[2] !== '10000000') problem(`H: rate/limit on row ${w[1]}/${w[2]}`);
    const sent = psql(`SELECT request_body->>'type', request_body->>'currency', request_body->>'amount' FROM payout_attempts WHERE withdrawal_id='${id}' ORDER BY attempt_no LIMIT 1`)[0];
    say(`  payout request: type=${sent[0]} currency=${sent[1]} amount=${sent[2]}`);
    if (sent[0] !== 'CRYPTO' || sent[1] !== 'USDT' || sent[2] !== '10') problem(`H: payout body ${sent.join('/')}`);
    const bal = Object.fromEntries(psql(`SELECT kind, balance_minor FROM accounts WHERE user_id='${u}' AND currency='USDT'`));
    const feeGain = feeRevenue() - feeBefore;
    say(`  balances ${JSON.stringify(bal)}; FEE_REVENUE grew by ${feeGain} micro-USDT (must be 1000000)`);
    if (bal.FROZEN !== '0' || bal.AVAILABLE !== '0') problem(`H: balances ${JSON.stringify(bal)}`);
    if (feeGain !== 1000000n) problem(`H: fee revenue grew by ${feeGain}`);

    const m = `chH_${run}_mix`;
    await seed(m, 'IRT', '1000000000'); await seed(m, 'USDT', '10000');
    const a = await call('POST', '/withdrawals', { userId: m, currency: 'IRT', amount: '150000000', destination: IBAN }, { 'idempotency-key': `h-irt-${run}` });
    const b = await call('POST', '/withdrawals', usdtBody(m, '500'), { 'idempotency-key': `h-usdt-${run}` });
    const c = await call('POST', '/withdrawals', usdtBody(m, '10'), { 'idempotency-key': `h-usdt2-${run}` });
    const d = await call('POST', '/withdrawals', { userId: m, currency: 'IRT', amount: '1000000', destination: IBAN }, { 'idempotency-key': `h-irt2-${run}` });
    say(`  cap 200M toman: IRT 150M -> ${a.status}; USDT 500 (=50M toman) -> ${b.status}; USDT 10 -> ${c.status} ${c.body?.code}; IRT 1M -> ${d.status} ${d.body?.code}`);
    if (a.status !== 201 || b.status !== 201) problem(`H: the first two should fit the cap exactly (${a.status}, ${b.status})`);
    if (c.status !== 422 || c.body?.code !== 'DAILY_LIMIT_EXCEEDED') problem(`H: USDT over the cap answered ${c.status}`);
    if (d.status !== 422 || d.body?.code !== 'DAILY_LIMIT_EXCEEDED') problem(`H: IRT over the cap answered ${d.status}`);
    const used = psql(`SELECT used_rial FROM withdrawal_daily_usage WHERE user_id='${m}'`)[0][0];
    say(`  day usage: ${used} rial (must be 2000000000, the cap)`);
    if (used !== '2000000000') problem(`H: usage ${used}`);
    await finals([a, b].filter((r) => r.status === 201).map((r) => ({ id: r.body.withdrawalId })), 'withdrawals', 420);
    await globalChecks('H');
  },
  async G() {
    say('G: money races: parallel withdrawals against one balance and against the daily limit');
    await setSimulator('default'); await waitHealthy();
    const u = `chG_${run}_bal`;
    await untilDone('POST', '/internal/adjustments', { userId: u, currency: 'IRT', amount: '1000000', reason: 'chaos seed' }, { 'idempotency-key': `seed-${u}` });
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => call('POST', '/withdrawals', { userId: u, currency: 'IRT', amount: '150000', destination: IBAN }, { 'idempotency-key': `race-${run}-${i}` })));
    const ok = rs.filter((r) => r.status === 201).length;
    const codes = Object.entries(rs.filter((r) => r.status !== 201).reduce((a, r) => (a[`${r.status}:${r.body?.code}`] = (a[`${r.status}:${r.body?.code}`] ?? 0) + 1, a), {}));
    say(`  30 parallel withdrawals of 150,000 from 1,000,000: accepted ${ok}, refused ${JSON.stringify(codes)}`);
    if (ok !== 6) problem(`G: expected exactly 6 accepted, got ${ok}`);
    const bal = Object.fromEntries(psql(`SELECT kind, balance_minor FROM accounts WHERE user_id='${u}' AND currency='IRR'`));
    say('  balances (rial)', JSON.stringify(bal));
    if (bal.FROZEN !== '9000000' || bal.AVAILABLE !== '1000000') problem(`G: balances wrong ${JSON.stringify(bal)}`);
    const big = `chG_${run}_cap`;
    await untilDone('POST', '/internal/adjustments', { userId: big, currency: 'IRT', amount: '900000000', reason: 'chaos seed' }, { 'idempotency-key': `seed-${big}` });
    const cs = await Promise.all(Array.from({ length: 8 }, (_, i) => call('POST', '/withdrawals', { userId: big, currency: 'IRT', amount: '150000000', destination: IBAN }, { 'idempotency-key': `cap-${run}-${i}` })));
    const cok = cs.filter((r) => r.status === 201).length;
    say(`  8 parallel withdrawals of 150M against a 200M daily cap: accepted ${cok}`);
    if (cok !== 1) problem(`G: expected exactly 1 accepted under the daily cap, got ${cok}`);
    const ids = rs.concat(cs).filter((r) => r.status === 201).map((r) => ({ id: r.body.withdrawalId }));
    await finals(ids, 'withdrawals', 420);
    await globalChecks('G');
  },
  async F() {
    say('F: simulator restarted mid-flow (all provider state lost): nothing may be lost or invented');
    await setSimulator('default'); await waitHealthy();
    const items = await depositFlow('F', 10, { payIt: true });
    const users = Array.from({ length: 6 }, (_, i) => `chF_${run}_w${i}`);
    for (const u of users) await untilDone('POST', '/internal/adjustments', { userId: u, currency: 'IRT', amount: '1000000', reason: 'chaos seed' }, { 'idempotency-key': `seed-${u}` });
    const w = await Promise.all(users.map((u) => untilDone('POST', '/withdrawals', { userId: u, currency: 'IRT', amount: '150000', destination: IBAN }, { 'idempotency-key': `wd-${u}` })));
    await sleep(2000);
    say('  restarting simulator (state lost)'); await setSimulator('default'); await waitHealthy();
    await sleep(45000);
    await verifyDeposits(items, 'F');
    const wd = psql(`SELECT status || CASE WHEN needs_review THEN '+review:' || review_reason ELSE '' END, count(*) FROM withdrawals WHERE user_id LIKE 'chF_${run}_w%' GROUP BY 1`);
    say('  withdrawal outcomes after the provider forgot them', JSON.stringify(Object.fromEntries(wd)));
    const fz = psql(`SELECT count(*) FROM accounts WHERE user_id LIKE 'chF_${run}_w%' AND kind='FROZEN' AND balance_minor > 0`)[0][0];
    say(`  users still holding frozen funds: ${fz} (money stays frozen, never released by silence)`);
    await globalChecks('F');
  },
};

const wanted = process.argv.slice(2);
for (const name of wanted) {
  const t0 = Date.now();
  try { await scenarios[name](); } catch (e) { problem(`${name} crashed: ${e.stack}`); }
  say(`-- ${name} done in ${((Date.now() - t0) / 1000).toFixed(0)}s; problems so far: ${problems.length}\n`);
}
say(problems.length ? `PROBLEMS (${problems.length}):\n` + problems.map((p) => ' - ' + p).join('\n') : 'NO PROBLEMS');

if (problems.length) process.exitCode = 1;
