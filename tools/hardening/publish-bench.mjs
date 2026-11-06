// How fast can one connection publish persistent, mandatory messages to a quorum queue with confirms, the way the outbox relay does?
//   node tools/hardening/publish-bench.mjs [messages]
// It compares waiting for each confirm before the next publish (what the relay does today) with keeping several publishes in flight.
// Uses a throwaway queue that it deletes at the end. Needs the stack's RabbitMQ: docker compose up -d --wait rabbitmq
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const amqp = require('amqplib');
const MESSAGES = Number(process.argv[2] ?? 3000);

const port = spawnSync('docker', ['compose', 'port', 'rabbitmq', '5672'], { encoding: 'utf8' }).stdout.trim().split(':').pop();
const url = process.env.RABBIT_URL ?? `amqp://guest:guest@127.0.0.1:${port}`;
const queue = `bench.publish.${randomUUID().slice(0, 8)}`;
const body = Buffer.from(JSON.stringify({ messageId: '1', type: 'job.withdrawal.sync', aggregateType: 'WITHDRAWAL', aggregateId: randomUUID(), payload: { withdrawalId: randomUUID() } }));

const conn = await amqp.connect(url);
const ch = await conn.createConfirmChannel();
await ch.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'quorum' } });

const publish = (i) => new Promise((resolve, reject) => ch.publish('', queue, body, { persistent: true, mandatory: true, messageId: String(i), contentType: 'application/json' }, (err) => (err ? reject(err) : resolve())));

/** `inFlight` publishes may be unconfirmed at once; 1 is "wait for each confirm". */
async function run(inFlight) {
  const t0 = performance.now();
  const pending = new Set();
  for (let i = 0; i < MESSAGES; i++) {
    const p = publish(i).finally(() => pending.delete(p));
    pending.add(p);
    if (pending.size >= inFlight) await Promise.race(pending);
  }
  await Promise.all(pending);
  const s = (performance.now() - t0) / 1000;
  console.log(`in flight ${String(inFlight).padStart(4)}: ${(MESSAGES / s).toFixed(0).padStart(6)} msg/s (${MESSAGES} messages in ${s.toFixed(2)}s, ${((s / MESSAGES) * 1000).toFixed(2)} ms each)`);
}

console.log(`publisher confirms to a quorum queue at ${url.replace(/\/\/.*@/, '//')}`);
for (const n of [1, 10, 100, 1000]) await run(n);
await ch.deleteQueue(queue);
await conn.close();
