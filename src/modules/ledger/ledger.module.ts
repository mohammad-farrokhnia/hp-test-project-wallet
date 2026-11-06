import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging';
import { LedgerService } from './ledger.service';
import { AccountsRepository } from './repositories/accounts.repository';
import { HistoryRepository } from './repositories/history.repository';
import { JournalsRepository } from './repositories/journals.repository';
import { LedgerChecksRepository } from './repositories/ledger-checks.repository';

@Module({
  imports: [MessagingModule],
  providers: [
    AccountsRepository,
    JournalsRepository,
    LedgerChecksRepository,
    HistoryRepository,
    LedgerService,
  ],
  exports: [LedgerService],
})
export class LedgerModule {}
