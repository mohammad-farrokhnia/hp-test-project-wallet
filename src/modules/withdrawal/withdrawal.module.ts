import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { IdempotencyModule } from '../idempotency';
import { LedgerModule } from '../ledger';
import { MessagingModule } from '../messaging';
import { buildPolicies } from './domain/withdrawal-policy';
import { DailyLimitRepository } from './repositories/daily-limit.repository';
import { WithdrawalsRepository } from './repositories/withdrawals.repository';
import { WithdrawalController } from './withdrawal.controller';
import { WITHDRAWAL_POLICIES, WithdrawalService } from './withdrawal.service';

@Module({
  imports: [LedgerModule, IdempotencyModule, MessagingModule],
  providers: [
    WithdrawalService,
    WithdrawalsRepository,
    DailyLimitRepository,
    {
      provide: WITHDRAWAL_POLICIES,
      inject: [AppConfig],
      useFactory: (c: AppConfig) => buildPolicies(c.limits),
    },
  ],
  exports: [WithdrawalService],
})
export class WithdrawalModule {}

@Module({
  imports: [WithdrawalModule],
  controllers: [WithdrawalController],
})
export class WithdrawalApiModule {}
