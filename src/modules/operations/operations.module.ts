import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger';
import { InvariantsController } from './invariants/invariants.controller';
import { InvariantsService } from './invariants/invariants.service';
import {
  NoOpenWithdrawals,
  OPEN_WITHDRAWAL_TOTALS,
} from './invariants/open-withdrawal-totals';

@Module({
  imports: [LedgerModule],
  controllers: [InvariantsController],
  providers: [
    InvariantsService,
    { provide: OPEN_WITHDRAWAL_TOTALS, useClass: NoOpenWithdrawals },
  ],
  exports: [InvariantsService],
})
export class OperationsModule {}
