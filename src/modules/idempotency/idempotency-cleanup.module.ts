import { Module } from '@nestjs/common';
import { IdempotencyCleanupJob } from './idempotency-cleanup.job';
import { IdempotencyKeysRepository } from './repositories/idempotency-keys.repository';

@Module({
  providers: [IdempotencyKeysRepository, IdempotencyCleanupJob],
})
export class IdempotencyCleanupModule {}
