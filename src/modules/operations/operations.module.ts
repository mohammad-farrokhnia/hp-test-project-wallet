import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency';
import { LedgerModule } from '../ledger';
import { AdjustmentsController } from './adjustments/adjustments.controller';
import { AdjustmentsRepository } from './adjustments/adjustments.repository';
import { AdjustmentsService } from './adjustments/adjustments.service';
import { InvariantsController } from './invariants/invariants.controller';
import { InvariantsService } from './invariants/invariants.service';
import {
  NoOpenWithdrawals,
  OPEN_WITHDRAWAL_TOTALS,
} from './invariants/open-withdrawal-totals';

@Module({
  imports: [LedgerModule, IdempotencyModule],
  controllers: [InvariantsController, AdjustmentsController],
  providers: [
    InvariantsService,
    AdjustmentsService,
    AdjustmentsRepository,
    { provide: OPEN_WITHDRAWAL_TOTALS, useClass: NoOpenWithdrawals },
  ],
  exports: [InvariantsService],
})
export class OperationsModule {}
