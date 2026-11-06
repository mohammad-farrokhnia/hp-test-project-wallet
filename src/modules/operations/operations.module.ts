import { Module } from '@nestjs/common';
import { DepositModule } from '../deposit';
import { IdempotencyModule } from '../idempotency';
import { PspModule } from '../integrations/psp';
import { LedgerModule } from '../ledger';
import { WithdrawalModule, WithdrawalService } from '../withdrawal';
import { AdjustmentsController } from './adjustments/adjustments.controller';
import { AdjustmentsRepository } from './adjustments/adjustments.repository';
import { AdjustmentsService } from './adjustments/adjustments.service';
import { InvariantsController } from './invariants/invariants.controller';
import { InvariantsService } from './invariants/invariants.service';
import { OPEN_WITHDRAWAL_TOTALS } from './invariants/open-withdrawal-totals';
import { ReconciliationController } from './reconciliation/reconciliation.controller';
import { ReconciliationRepository } from './reconciliation/reconciliation.repository';
import { ReconciliationService } from './reconciliation/reconciliation.service';

@Module({
  imports: [
    LedgerModule,
    IdempotencyModule,
    WithdrawalModule,
    DepositModule,
    PspModule,
  ],
  controllers: [
    InvariantsController,
    AdjustmentsController,
    ReconciliationController,
  ],
  providers: [
    InvariantsService,
    AdjustmentsService,
    AdjustmentsRepository,
    ReconciliationService,
    ReconciliationRepository,
    { provide: OPEN_WITHDRAWAL_TOTALS, useExisting: WithdrawalService },
  ],
  exports: [InvariantsService],
})
export class OperationsModule {}
