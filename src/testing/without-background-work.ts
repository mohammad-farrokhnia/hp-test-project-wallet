import type { TestingModuleBuilder } from '@nestjs/testing';
import { IdempotencyCleanupJob } from '../modules/idempotency/idempotency-cleanup.job';
import { JobConsumers } from '../modules/messaging/consumer/jobs.module';
import { OutboxRelay } from '../modules/messaging/outbox/outbox-relay';
import { SweeperRunner } from '../modules/scheduler/scheduler.module';

const idle = {
  start: () => undefined,
  stop: () => Promise.resolve(),
  onApplicationBootstrap: () => undefined,
  onApplicationShutdown: () => Promise.resolve(),
};

/**
 * @function withoutBackgroundWork
 * @description For tests that boot the worker role to check wiring: replaces the job consumers, outbox relay, sweeper and cleanup job with idle stand-ins.
 * Otherwise a test app would consume real jobs from the shared broker with a fake database, and dead-letter them.
 * @param builder - the testing module builder
 * @returns the same builder, overridden
 */
export function withoutBackgroundWork(
  builder: TestingModuleBuilder,
): TestingModuleBuilder {
  return builder
    .overrideProvider(JobConsumers)
    .useValue(idle)
    .overrideProvider(OutboxRelay)
    .useValue(idle)
    .overrideProvider(SweeperRunner)
    .useValue(idle)
    .overrideProvider(IdempotencyCleanupJob)
    .useValue(idle);
}
