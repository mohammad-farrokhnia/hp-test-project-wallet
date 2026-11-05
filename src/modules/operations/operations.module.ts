import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency';
import { LedgerModule } from '../ledger';
import { WithdrawalModule, WithdrawalService } from '../withdrawal';
import { AdjustmentsController } from './adjustments/adjustments.controller';
import { AdjustmentsRepository } from './adjustments/adjustments.repository';
import { AdjustmentsService } from './adjustments/adjustments.service';
import { InvariantsController } from './invariants/invariants.controller';
import { InvariantsService } from './invariants/invariants.service';
import { OPEN_WITHDRAWAL_TOTALS } from './invariants/open-withdrawal-totals';

@Module({
  imports: [LedgerModule, IdempotencyModule, WithdrawalModule],
  controllers: [InvariantsController, AdjustmentsController],
  providers: [
    InvariantsService,
    AdjustmentsService,
    AdjustmentsRepository,
    { provide: OPEN_WITHDRAWAL_TOTALS, useExisting: WithdrawalService },
  ],
  exports: [InvariantsService],
})
export class OperationsModule {}
