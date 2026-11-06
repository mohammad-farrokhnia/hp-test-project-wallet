import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency';
import { LedgerModule } from '../ledger';
import { TransferController } from './transfer.controller';
import { TransferService } from './transfer.service';
import { TransfersRepository } from './transfers.repository';

/** The transfer use case. */
@Module({
  imports: [LedgerModule, IdempotencyModule],
  providers: [TransferService, TransfersRepository],
  exports: [TransferService],
})
export class TransferModule {}

/** API role only: the HTTP edge, so the worker serves no transfer routes. */
@Module({
  imports: [TransferModule],
  controllers: [TransferController],
})
export class TransferApiModule {}
