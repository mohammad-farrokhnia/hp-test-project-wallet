import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger';
import { WithdrawalModule, WithdrawalService } from '../withdrawal';
import { InvariantsCheckJob } from './invariants/invariants-check.job';
import { InvariantsService } from './invariants/invariants.service';
import { OPEN_WITHDRAWAL_TOTALS } from './invariants/open-withdrawal-totals';

/**
 * @class InvariantsCheckModule
 * @description Worker role: the scheduled invariant check. Separate from `OperationsModule`, which carries the HTTP controllers the worker must not serve.
 */
@Module({
  imports: [LedgerModule, WithdrawalModule],
  providers: [
    InvariantsService,
    InvariantsCheckJob,
    { provide: OPEN_WITHDRAWAL_TOTALS, useExisting: WithdrawalService },
  ],
})
export class InvariantsCheckModule {}
