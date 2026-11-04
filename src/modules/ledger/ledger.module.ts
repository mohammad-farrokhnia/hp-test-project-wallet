import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { AccountsRepository } from './repositories/accounts.repository';

@Module({
  providers: [AccountsRepository, LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
