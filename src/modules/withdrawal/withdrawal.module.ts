import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { IdempotencyModule } from '../idempotency';
import { PayoutModule } from '../integrations/payout';
import { LedgerModule } from '../ledger';
import { MessagingModule } from '../messaging';
import { buildPolicies } from './domain/withdrawal-policy';
import { WithdrawalSubmitHandler } from './handlers/withdrawal-submit.handler';
import { WithdrawalSyncHandler } from './handlers/withdrawal-sync.handler';
import { WithdrawalDueWork } from './withdrawal.due-work';
import { WithdrawalReviewSource } from './withdrawal.review-work';
import { DailyLimitRepository } from './repositories/daily-limit.repository';
import { PayoutAttemptsRepository } from './repositories/payout-attempts.repository';
import { WithdrawalLifecycleRepository } from './repositories/withdrawal-lifecycle.repository';
import { WithdrawalsRepository } from './repositories/withdrawals.repository';
import { InboundEvents } from '../integrations/inbound-events';
import { PayoutWebhookController } from './webhook/payout-webhook.controller';
import { PayoutWebhookService } from './webhook/payout-webhook.service';
import { WithdrawalController } from './withdrawal.controller';
import { WITHDRAWAL_POLICIES, WithdrawalService } from './withdrawal.service';

/** The withdrawal use cases, for every role: the service, and the job handlers the worker runs. */
@Module({
  imports: [LedgerModule, IdempotencyModule, MessagingModule, PayoutModule],
  providers: [
    WithdrawalService,
    WithdrawalsRepository,
    WithdrawalLifecycleRepository,
    DailyLimitRepository,
    PayoutAttemptsRepository,
    WithdrawalSubmitHandler,
    WithdrawalSyncHandler,
    WithdrawalDueWork,
    WithdrawalReviewSource,
    InboundEvents,
    PayoutWebhookService,
    {
      provide: WITHDRAWAL_POLICIES,
      inject: [AppConfig],
      useFactory: (c: AppConfig) => buildPolicies(c.limits),
    },
  ],
  exports: [
    WithdrawalService,
    WithdrawalSubmitHandler,
    WithdrawalSyncHandler,
    WithdrawalDueWork,
    WithdrawalReviewSource,
    PayoutWebhookService,
  ],
})
export class WithdrawalModule {}

/** API role only: the HTTP edge, so the worker serves no withdrawal routes. */
@Module({
  imports: [WithdrawalModule],
  controllers: [WithdrawalController, PayoutWebhookController],
})
export class WithdrawalApiModule {}
