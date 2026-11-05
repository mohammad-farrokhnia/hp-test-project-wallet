import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency';
import { InboundEvents } from '../integrations/inbound-events';
import { PspModule } from '../integrations/psp';
import { LedgerModule } from '../ledger';
import { MessagingModule } from '../messaging';
import { PspCallbackController } from './callback/psp-callback.controller';
import { PspCallbackService } from './callback/psp-callback.service';
import { DepositController } from './deposit.controller';
import { DepositDueWork } from './deposit.due-work';
import { DepositService } from './deposit.service';
import { DepositWatchdog } from './deposit.watchdog';
import { DepositSyncHandler } from './handlers/deposit-sync.handler';
import { DepositLifecycleRepository } from './repositories/deposit-lifecycle.repository';
import { DepositsRepository } from './repositories/deposits.repository';

@Module({
  imports: [LedgerModule, IdempotencyModule, MessagingModule, PspModule],
  providers: [
    DepositService,
    DepositsRepository,
    DepositLifecycleRepository,
    DepositSyncHandler,
    DepositDueWork,
    DepositWatchdog,
    InboundEvents,
    PspCallbackService,
  ],
  exports: [
    DepositService,
    DepositSyncHandler,
    DepositDueWork,
    DepositWatchdog,
    PspCallbackService,
  ],
})
export class DepositModule {}

/** API role only: the HTTP edge, so the worker serves no deposit routes. */
@Module({
  imports: [DepositModule],
  controllers: [DepositController, PspCallbackController],
})
export class DepositApiModule {}
