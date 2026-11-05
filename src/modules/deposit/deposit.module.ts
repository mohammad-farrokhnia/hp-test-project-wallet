import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency';
import { PspModule } from '../integrations/psp';
import { DepositController } from './deposit.controller';
import { DepositService } from './deposit.service';
import { DepositsRepository } from './repositories/deposits.repository';

/** The deposit use cases, for every role. */
@Module({
  imports: [IdempotencyModule, PspModule],
  providers: [DepositService, DepositsRepository],
  exports: [DepositService],
})
export class DepositModule {}

/** API role only: the HTTP edge, so the worker serves no deposit routes. */
@Module({
  imports: [DepositModule],
  controllers: [DepositController],
})
export class DepositApiModule {}
