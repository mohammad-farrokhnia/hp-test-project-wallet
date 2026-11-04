import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { AccountsRepository } from './repositories/accounts.repository';
import { JournalsRepository } from './repositories/journals.repository';
import { LedgerChecksRepository } from './repositories/ledger-checks.repository';

@Module({
  providers: [
    AccountsRepository,
    JournalsRepository,
    LedgerChecksRepository,
    LedgerService,
  ],
  exports: [LedgerService],
})
export class LedgerModule {}
