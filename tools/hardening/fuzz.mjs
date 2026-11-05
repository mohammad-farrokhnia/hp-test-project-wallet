// Wrong-input fuzzer for the HTTP API behind nginx. Needs the compose stack up.
//   node tools/hardening/fuzz.mjs        (APP_HOST / APP_PORT / PAYOUT_WEBHOOK_SECRET override the defaults)
// A case fails on any 5xx, on a 2xx where the input must be refused, or on a wrong idempotency answer. Exit code 1 if any fails.
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

const HOST = process.env.APP_HOST ?? '127.0.0.1';
const PORT = parseInt(process.env.APP_PORT ?? '3000', 10);
const SECRET = process.env.PAYOUT_WEBHOOK_SECRET ?? 'hamtapay-sim-secret';
const IBAN = 'IR330566736841214070501510';
const run = Math.random().toString(36).slice(2, 7);
let n = 0;
const results = [];

/** Raw request so nothing normalises the bytes, the headers or the method. */
function raw(method, path, { headers = {}, body = undefined, bodyBuf = undefined } = {}) {
  return new Promise((resolve) => {
    const data = bodyBuf ?? (body === undefined ? undefined : Buffer.from(body));
    let req;
    try { req = http.request({ host: HOST, port: PORT, method, path, headers: { ...(data ? { 'content-length': data.length } : {}), ...headers }, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    }); } catch (e) { return resolve({ status: 'CLIENT_REFUSED', text: String(e.code) }); }
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', text: '' }); });
    req.on('error', (e) => resolve({ status: `ERR:${e.code}`, text: String(e.message) }));
    if (data) req.write(data);
    req.end();
  });
}
const J = (o) => JSON.stringify(o);
const jsonH = (extra = {}) => ({ 'content-type': 'application/json', ...extra });

/** mustReject: any 2xx is a bug too. */
async function check(name, method, path, opts, { mustReject = false, expect = null } = {}) {
  const r = await raw(method, path, opts);
  n++;
  if (r.status === 'CLIENT_REFUSED') { results.push({ name, status: r.status, bad: false }); return r; }
  const bad5xx = typeof r.status !== 'number' || r.status >= 500;
  const badAccept = mustReject && r.status >= 200 && r.status < 300;
  const badExpect = expect !== null && r.status !== expect;
  const noCode = typeof r.status === 'number' && r.status >= 400 && r.status < 500 && !(r.json && typeof r.json.code === 'string');
  results.push({ name, status: r.status, bad: bad5xx || badAccept || badExpect, why: bad5xx ? '5xx/transport' : badAccept ? 'accepted' : badExpect ? `expected ${expect}` : null, noCode, sample: (r.text ?? '').slice(0, 140) });
  return r;
}
const key = () => `fz-${run}-${++n}-${randomUUID().slice(0, 6)}`;
const dep = (body, k = key(), h = {}) => ({ headers: jsonH({ 'idempotency-key': k, ...h }), body: typeof body === 'string' ? body : J(body) });
const user = () => `fz_${run}_${randomUUID().slice(0, 8)}`;

const okBody = () => ({ userId: user(), amount: '1000' });
for (const [name, body] of [
  ['null body', 'null'], ['array', '[]'], ['string', '"x"'], ['number', '123'], ['empty object', '{}'], ['empty string body', ''],
  ['truncated json', '{"userId":"a","amount"'], ['trailing garbage', '{"userId":"a","amount":"1000"}xx'],
  ['single quotes', "{'userId':'a'}"], ['NaN', '{"userId":"a","amount":NaN}'], ['deep nesting 5000', '['.repeat(5000) + ']'.repeat(5000)],
  ['deep nesting 300000', '['.repeat(300000) + ']'.repeat(300000)],
]) await check(`deposit body: ${name}`, 'POST', '/deposits', dep(body), { mustReject: true });

await check('deposit body: BOM json', 'POST', '/deposits', dep('\ufeff{"userId":"bom_' + user() + '","amount":"1000"}'), { expect: 201 });
await check('deposit body: __proto__ key', 'POST', '/deposits', dep(`{"__proto__":{"polluted":1},"userId":"${user()}","amount":"1000"}`), { expect: 201 });
await check('proto pollution did not leak', 'GET', '/health', {}, { expect: 200 });

for (const amount of [null, 1000, 1000.5, true, [], {}, '', ' ', 'abc', '-1000', '0', '0.0', '1e3', '1000.5', ' 1000', '1000 ', '١٠٠٠', '１０００', '0x3e8', '1,000', '+1000', '999', '1000.0000001', '9'.repeat(30), '922337203685477580', '922337203685477581', '9223372036854775807', '92233720368547758070', '00001000x', '1000\n', '1000\u0000'])
  await check(`deposit amount ${J(amount)?.slice(0, 40)}`, 'POST', '/deposits', dep({ userId: user(), amount }), { mustReject: !['1000.5'].includes(amount) && amount !== '1000.0000001' && amount !== '00001000x' ? undefined : true });
for (const amount of ['1000', '1001', '5000000'])
  await check(`deposit amount ok ${amount}`, 'POST', '/deposits', dep({ userId: user(), amount }), { expect: 201 });
await check('deposit amount with leading zeros is refused', 'POST', '/deposits', dep({ userId: user(), amount: '00001000' }), { expect: 400 });

for (const userId of [null, 5, '', ' ', 'a'.repeat(64), 'a'.repeat(65), 'a b', "x'; DROP TABLE deposits;--", 'ü', '日本語', 'a\u0000b', '../../etc/passwd', '<script>alert(1)</script>', '__proto__', 'constructor', '${jndi:ldap://x}', '%00', 'a\nb'])
  await check(`deposit userId ${J(userId)?.slice(0, 40)}`, 'POST', '/deposits', dep({ userId, amount: '1000' }), { mustReject: !(userId === 'a'.repeat(64) || userId === '__proto__' || userId === 'constructor') ? true : undefined });
await check('deposit userId 64 chars ok', 'POST', '/deposits', dep({ userId: 'b'.repeat(64), amount: '1000' }), { expect: 201 });

await check('deposit extra field', 'POST', '/deposits', dep({ ...okBody(), foo: 1 }), { mustReject: true });
await check('deposit currency USDT', 'POST', '/deposits', dep({ ...okBody(), currency: 'USDT' }), { mustReject: true });
await check('deposit currency lowercase', 'POST', '/deposits', dep({ ...okBody(), currency: 'irt' }), { mustReject: true });
await check('deposit duplicate json keys', 'POST', '/deposits', dep(`{"userId":"${user()}","amount":"1","amount":"1000"}`));

for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'application/xml', 'multipart/form-data; boundary=x', 'application/json; charset=utf-16', '', 'application/jsonx'])
  await check(`deposit content-type "${ct}"`, 'POST', '/deposits', { headers: { ...(ct ? { 'content-type': ct } : {}), 'idempotency-key': key() }, body: J(okBody()) });
await check('deposit body 200 KB', 'POST', '/deposits', dep(J({ ...okBody(), pad: 'x'.repeat(200_000) })), { mustReject: true });
await check('deposit body 3 MB', 'POST', '/deposits', dep(J({ ...okBody(), pad: 'x'.repeat(3_000_000) })), { mustReject: true });
await check('deposit invalid utf8 body', 'POST', '/deposits', { headers: jsonH({ 'idempotency-key': key() }), bodyBuf: Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]) }, { mustReject: true });

for (const [name, k] of [['empty', ''], ['space', ' '], ['300 chars', 'k'.repeat(300)], ['255 chars', 'k'.repeat(255)], ['unicode', 'کلید-' + randomUUID()], ['sql', "k'; DROP TABLE idempotency_keys;--"], ['slash', 'a/b/' + randomUUID()], ['control char', 'a\tb' + randomUUID()]])
  await check(`deposit key ${name}`, 'POST', '/deposits', { headers: jsonH({ 'idempotency-key': k }), body: J(okBody()) });
await check('deposit no key', 'POST', '/deposits', { headers: jsonH(), body: J(okBody()) }, { expect: 400 });
await check('deposit two key headers', 'POST', '/deposits', { headers: jsonH({ 'idempotency-key': [key(), key()] }), body: J(okBody()) });

{
  const k = key(); const b = okBody();
  const a = await check('idem first', 'POST', '/deposits', dep(b, k), { expect: 201 });
  const c = await check('idem replay', 'POST', '/deposits', dep(b, k), { expect: 201 });
  results.push({ name: 'idem replay same id + header', status: c.json?.depositId === a.json?.depositId && c.headers['idempotent-replayed'] === 'true' ? 'ok' : 'WRONG', bad: !(c.json?.depositId === a.json?.depositId && c.headers['idempotent-replayed'] === 'true') });
  await check('idem same key other amount', 'POST', '/deposits', dep({ ...b, amount: '2000' }, k), { expect: 422 });
  await check('idem same key other user', 'POST', '/deposits', dep({ ...b, userId: user() }, k), { expect: 422 });
  const reordered = `{"amount":"${b.amount}","userId":"${b.userId}"}`;
  const r = await check('idem same key reordered fields', 'POST', '/deposits', dep(reordered, k));
  results.push({ name: '  (reordered fields is a replay: same deposit)', status: r.status, bad: !(r.status === 201 && r.json?.depositId === a.json?.depositId) });
}
{
  const k = key(); const u = user();
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => raw('POST', '/deposits', dep({ userId: u, amount: String(1000 + i) }, k))));
  const codes = rs.map((r) => r.status).sort().join(',');
  const ids = new Set(rs.filter((r) => r.status === 201).map((r) => r.json.depositId));
  results.push({ name: 'idem 10 concurrent different bodies', status: codes, bad: rs.some((r) => typeof r.status !== 'number' || r.status >= 500) || ids.size !== 1, why: `winners ${ids.size}` });
}

for (const id of ['', 'x', randomUUID(), randomUUID().toUpperCase(), '0'.repeat(36), '%00', '..%2f..%2fetc%2fpasswd', "1'%20OR%20'1'='1", 'a'.repeat(5000), '%FF%FE', '01a1acf3-8810-7dc0-b778-176375279c7', '01a1acf3-8810-7dc0-b778-176375279c71x'])
  await check(`GET /deposits/${id.slice(0, 30)}`, 'GET', `/deposits/${id}`, {});
for (const u of ['x', "a'b", '%00', 'a'.repeat(65), 'a'.repeat(5000), '%FF', '日本', 'a%20b', '..%2f'])
  await check(`GET /wallets/${u.slice(0, 20)}`, 'GET', `/wallets/${u}`, {});
for (const q of ['limit=-1', 'limit=0', 'limit=1000000', 'limit=abc', 'limit=1.5', 'limit=1&limit=2', 'beforeId=abc', 'beforeId=-1', 'beforeId=99999999999999999999999', 'beforeId=9223372036854775807', 'beforeId=9223372036854775808', 'limit[]=1', 'x=y', 'limit=%00'])
  await check(`GET ledger ?${q}`, 'GET', `/wallets/fz_${run}_ledger/ledger?${q}`, {});

{
  const u = user();
  await raw('POST', '/internal/adjustments', { headers: jsonH({ 'idempotency-key': key() }), body: J({ userId: u, currency: 'IRT', amount: '1000000', reason: 'fuzz seed' }) });
  const w = (body, k = key()) => ({ headers: jsonH({ 'idempotency-key': k }), body: typeof body === 'string' ? body : J(body) });
  for (const [name, b, ok] of [
    ['bad IBAN checksum', { userId: u, currency: 'IRT', amount: '150000', destination: 'IR330566736841214070501511' }, false],
    ['IBAN wrong country', { userId: u, currency: 'IRT', amount: '150000', destination: 'DE89370400440532013000' }, false],
    ['IBAN too short', { userId: u, currency: 'IRT', amount: '150000', destination: 'IR33' }, false],
    ['TRC20 for IRT', { userId: u, currency: 'IRT', amount: '150000', destination: 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y79bP' }, false],
    ['IBAN for USDT', { userId: u, currency: 'USDT', amount: '10', destination: IBAN }, false],
    ['bad TRC20 checksum', { userId: u, currency: 'USDT', amount: '10', destination: 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y79bQ' }, false],
    ['below minimum', { userId: u, currency: 'IRT', amount: '99999', destination: IBAN }, false],
    ['zero', { userId: u, currency: 'IRT', amount: '0', destination: IBAN }, false],
    ['negative', { userId: u, currency: 'IRT', amount: '-150000', destination: IBAN }, false],
    ['overflow', { userId: u, currency: 'IRT', amount: '9'.repeat(25), destination: IBAN }, false],
    ['USDT 7 decimals', { userId: u, currency: 'USDT', amount: '10.1234567', destination: 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y79bP' }, false],
    ['insufficient funds', { userId: u, currency: 'IRT', amount: '5000000', destination: IBAN }, false],
    ['unknown user (no funds)', { userId: user(), currency: 'IRT', amount: '150000', destination: IBAN }, false],
    ['destination null', { userId: u, currency: 'IRT', amount: '150000', destination: null }, false],
    ['destination object', { userId: u, currency: 'IRT', amount: '150000', destination: {} }, false],
    ['destination 10 KB', { userId: u, currency: 'IRT', amount: '150000', destination: 'I'.repeat(10000) }, false],
    ['lowercase spaced IBAN ok', { userId: u, currency: 'IRT', amount: '150000', destination: 'ir33 0566 7368 4121 4070 5015 10' }, true],
  ]) await check(`withdraw ${name}`, 'POST', '/withdrawals', w(b), ok ? { expect: 201 } : { mustReject: true });
  await check('withdraw no key', 'POST', '/withdrawals', { headers: jsonH(), body: J({ userId: u, currency: 'IRT', amount: '150000', destination: IBAN }) }, { expect: 400 });
  const big = user();
  await raw('POST', '/internal/adjustments', { headers: jsonH({ 'idempotency-key': key() }), body: J({ userId: big, currency: 'IRT', amount: '900000000', reason: 'fuzz seed' }) });
  const r1 = await check('withdraw 150M toman (under 200M cap)', 'POST', '/withdrawals', w({ userId: big, currency: 'IRT', amount: '150000000', destination: IBAN }), { expect: 201 });
  await check('withdraw second 150M (over daily cap)', 'POST', '/withdrawals', w({ userId: big, currency: 'IRT', amount: '150000000', destination: IBAN }), { mustReject: true });
}

for (const [name, b, h] of [
  ['negative', { userId: user(), currency: 'IRT', amount: '-5', reason: 'fuzz test' }, {}],
  ['zero', { userId: user(), currency: 'IRT', amount: '0', reason: 'fuzz test' }, {}],
  ['reason too short', { userId: user(), currency: 'IRT', amount: '5', reason: 'x' }, {}],
  ['reason 501', { userId: user(), currency: 'IRT', amount: '5', reason: 'x'.repeat(501) }, {}],
  ['bad currency', { userId: user(), currency: 'EUR', amount: '5', reason: 'fuzz test' }, {}],
  ['operator header with newline-ish', { userId: user(), currency: 'IRT', amount: '5', reason: 'fuzz test' }, { 'x-operator-id': 'aéb' }],
  ['operator 200 chars', { userId: user(), currency: 'IRT', amount: '5', reason: 'fuzz test' }, { 'x-operator-id': 'o'.repeat(200) }],
]) await check(`adjustment ${name}`, 'POST', '/internal/adjustments', { headers: jsonH({ 'idempotency-key': key(), ...h }), body: J(b) }, { mustReject: true });

const sign = (body) => createHmac('sha256', SECRET).update(body).digest('hex');
for (const [name, body, sig] of [
  ['payout no signature', J({ requestId: randomUUID(), status: 'SUCCEEDED' }), null],
  ['payout wrong signature', J({ requestId: randomUUID(), status: 'FAILED' }), 'deadbeef'],
  ['payout signature wrong length', J({}), 'a'.repeat(1000)],
  ['payout sig non-hex', J({}), 'zzzz'],
  ['payout valid sig, garbage json', '{{{{', 'SIGN'],
  ['payout valid sig, array', '[1,2,3]', 'SIGN'],
  ['payout valid sig, empty', '', 'SIGN'],
  ['payout valid sig, requestId number', J({ requestId: 5, status: 'SUCCEEDED' }), 'SIGN'],
  ['payout valid sig, unknown id', J({ requestId: randomUUID(), status: 'SUCCEEDED' }), 'SIGN'],
  ['payout valid sig, 1 MB body', J({ requestId: randomUUID(), pad: 'x'.repeat(1_000_000) }), 'SIGN'],
]) {
  const headers = { 'content-type': 'application/json', ...(sig ? { 'x-signature': sig === 'SIGN' ? sign(body) : sig } : {}) };
  const r = await check(`webhook ${name}`, 'POST', '/webhooks/payout', { headers, body });
  const allowed = name.includes('1 MB') ? [400, 413] : sig === null || sig === 'deadbeef' || sig === 'zzzz' || sig.length > 100 ? [401] : [200];
  results.push({ name: `  (${name}: must answer ${allowed.join('/')})`, status: r.status, bad: !allowed.includes(r.status) });
}
for (const [name, path, body, ct] of [
  ['unknown uuid', `/webhooks/psp/callback/${randomUUID()}`, J({ token: 'A0x', orderId: 'x', status: 'OK' }), 'application/json'],
  ['not a uuid', '/webhooks/psp/callback/zzz', J({}), 'application/json'],
  ['sql in id', "/webhooks/psp/callback/1'%20OR%20'1'='1", J({}), 'application/json'],
  ['empty body', `/webhooks/psp/callback/${randomUUID()}`, '', 'application/json'],
  ['no content-type', `/webhooks/psp/callback/${randomUUID()}`, J({ a: 1 }), ''],
  ['form-encoded', `/webhooks/psp/callback/${randomUUID()}`, 'token=A0x&status=OK', 'application/x-www-form-urlencoded'],
  ['array', `/webhooks/psp/callback/${randomUUID()}`, '[1]', 'application/json'],
  ['1 MB', `/webhooks/psp/callback/${randomUUID()}`, J({ pad: 'x'.repeat(1_000_000) }), 'application/json'],
  ['null bytes in text', `/webhooks/psp/callback/${randomUUID()}`, 'a\u0000b', 'text/plain'],
]) {
  const r = await check(`psp callback ${name}`, 'POST', path, { headers: ct ? { 'content-type': ct } : {}, body });
  const allowed = name === '1 MB' ? [400, 413] : [200];
  results.push({ name: `  (${name}: must answer ${allowed.join('/')})`, status: r.status, bad: !allowed.includes(r.status) });
}

for (const [m, p] of [['DELETE', '/deposits/x'], ['PUT', '/deposits'], ['PATCH', '/withdrawals/x'], ['GET', '/deposits'], ['GET', '/withdrawals'], ['POST', '/wallets/x'], ['OPTIONS', '/deposits'], ['HEAD', '/health'], ['GET', '/nope'], ['POST', '/webhooks'], ['GET', '/webhooks/payout'], ['GET', '/internal/adjustments'], ['TRACE', '/health'], ['GET', '//deposits'], ['GET', '/deposits/'], ['GET', '/%'], ['GET', '/..%2f..%2f']])
  await check(`${m} ${p}`, m, p, {});
await check('very long url', 'GET', '/deposits/' + 'a'.repeat(20000), {});
await check('100 KB header', 'GET', '/health', { headers: { 'x-big': 'h'.repeat(100000) } });

const bad = results.filter((r) => r.bad);
const noCode = results.filter((r) => r.noCode);
const by = results.reduce((a, r) => (a[r.status] = (a[r.status] ?? 0) + 1, a), {});
console.log('cases:', results.length, 'status counts:', JSON.stringify(by));
console.log('PROBLEMS:', bad.length);
for (const b of bad) console.log(` - ${b.name} -> ${b.status} ${b.why ?? ''} ${b.sample ?? ''}`);
console.log('4xx without a JSON error code:', noCode.length);
for (const b of noCode) console.log(` - ${b.name} -> ${b.status} ${b.sample}`);

if (bad.length) process.exitCode = 1;
