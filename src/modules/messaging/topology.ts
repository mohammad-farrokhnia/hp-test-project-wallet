import type { Channel } from 'amqplib';

/** Job queues; each is bound to `wallet.jobs` with a routing key equal to its name. */
export const JOB_NAMES = [
  'job.withdrawal.submit',
  'job.withdrawal.sync',
  'job.deposit.sync',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** Event queues; each is bound to `wallet.events` by the routing keys in `EVENT_ROUTING_KEYS`. */
export const EVENT_QUEUES = ['notify.events'] as const;
export type EventQueue = (typeof EVENT_QUEUES)[number];

/** Anything a `JobConsumer` can read: a job queue or an event queue. */
export type QueueName = JobName | EventQueue;

/** Emitted by the ledger, in the transaction of every journal, once per user whose balance it changed. */
export const BALANCE_CHANGED = 'wallet.balance.changed';
export const EVENT_ROUTING_KEYS = [
  BALANCE_CHANGED,
  'deposit.status.changed',
  'withdrawal.status.changed',
] as const;

export const JOBS_EXCHANGE = 'wallet.jobs';
export const EVENTS_EXCHANGE = 'wallet.events';
export const DEAD_LETTER_EXCHANGE = 'wallet.dlx';
export const DEAD_QUEUE = 'job.dead';

/** Deliveries before a job dead-letters to `job.dead` (modules.md). */
export const DELIVERY_LIMIT = 5;

/** Exchanges the outbox may target; mirrors `outbox_exchange_check`. */
export type OutboxExchange = typeof JOBS_EXCHANGE | typeof EVENTS_EXCHANGE;

export interface Topology {
  readonly exchanges: readonly {
    readonly name: string;
    readonly type: 'direct' | 'fanout' | 'topic';
  }[];
  readonly queues: readonly {
    readonly name: string;
    readonly arguments: Readonly<Record<string, string | number>>;
  }[];
  readonly bindings: readonly {
    readonly queue: string;
    readonly exchange: string;
    readonly routingKey: string;
  }[];
}

/**
 * @function buildTopology
 * @description The broker layout as data. Job and event queues are quorum queues (replicated, durable) with a delivery limit;
 * @param prefix - prepended to every exchange and queue name; empty in the app, unique per test so tests never touch real queues
 * @returns the topology
 */
export function buildTopology(prefix = ''): Topology {
  const n = (name: string) => `${prefix}${name}`;
  return {
    exchanges: [
      { name: n(JOBS_EXCHANGE), type: 'direct' },
      { name: n(EVENTS_EXCHANGE), type: 'topic' },
      { name: n(DEAD_LETTER_EXCHANGE), type: 'fanout' },
    ],
    queues: [
      ...[...JOB_NAMES, ...EVENT_QUEUES].map((job) => ({
        name: n(job),
        arguments: {
          'x-queue-type': 'quorum',
          'x-delivery-limit': DELIVERY_LIMIT,
          'x-dead-letter-exchange': n(DEAD_LETTER_EXCHANGE),
        },
      })),
      { name: n(DEAD_QUEUE), arguments: { 'x-queue-type': 'quorum' } },
    ],
    bindings: [
      ...JOB_NAMES.map((job) => ({
        queue: n(job),
        exchange: n(JOBS_EXCHANGE),
        routingKey: job,
      })),
      ...EVENT_QUEUES.flatMap((queue) =>
        EVENT_ROUTING_KEYS.map((routingKey) => ({
          queue: n(queue),
          exchange: n(EVENTS_EXCHANGE),
          routingKey,
        })),
      ),
      {
        queue: n(DEAD_QUEUE),
        exchange: n(DEAD_LETTER_EXCHANGE),
        routingKey: '',
      },
    ],
  };
}

/** The app's topology. */
export const TOPOLOGY = buildTopology();

/**
 * @function declareTopology
 * @description Declares every exchange, queue and binding.
 * Idempotent: declaring what already exists with the same arguments is a no-op, so every worker runs it on every (re)connect. Different arguments on an existing queue fail loudly (PRECONDITION_FAILED) rather than silently keeping the old ones.
 * @param ch - any open channel
 * @param topology - what to declare
 */
export async function declareTopology(
  ch: Channel,
  topology: Topology,
): Promise<void> {
  for (const ex of topology.exchanges) {
    await ch.assertExchange(ex.name, ex.type, { durable: true });
  }
  for (const q of topology.queues) {
    await ch.assertQueue(q.name, { durable: true, arguments: q.arguments });
  }
  for (const b of topology.bindings) {
    await ch.bindQueue(b.queue, b.exchange, b.routingKey);
  }
}
