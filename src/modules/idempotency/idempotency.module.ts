import { Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyKeysRepository } from './repositories/idempotency-keys.repository';

@Module({
  providers: [IdempotencyKeysRepository, IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
