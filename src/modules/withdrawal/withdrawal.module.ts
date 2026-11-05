import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { IdempotencyModule } from '../idempotency';
import { PayoutModule } from '../integrations/payout';
import { LedgerModule } from '../ledger';
import { MessagingModule } from '../messaging';
import { buildPolicies } from './domain/withdrawal-policy';
import { WithdrawalSubmitHandler } from './handlers/withdrawal-submit.handler';
import { DailyLimitRepository } from './repositories/daily-limit.repository';
import { PayoutAttemptsRepository } from './repositories/payout-attempts.repository';
import { WithdrawalsRepository } from './repositories/withdrawals.repository';
import { WithdrawalController } from './withdrawal.controller';
import { WITHDRAWAL_POLICIES, WithdrawalService } from './withdrawal.service';

@Module({
  imports: [LedgerModule, IdempotencyModule, MessagingModule, PayoutModule],
  providers: [
    WithdrawalService,
    WithdrawalsRepository,
    DailyLimitRepository,
    PayoutAttemptsRepository,
    WithdrawalSubmitHandler,
    {
      provide: WITHDRAWAL_POLICIES,
      inject: [AppConfig],
      useFactory: (c: AppConfig) => buildPolicies(c.limits),
    },
  ],
  exports: [WithdrawalService, WithdrawalSubmitHandler],
})
export class WithdrawalModule {}

/** API role only: the HTTP edge, so the worker serves no withdrawal routes. */
@Module({
  imports: [WithdrawalModule],
  controllers: [WithdrawalController],
})
export class WithdrawalApiModule {}
