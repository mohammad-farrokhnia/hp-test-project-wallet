import { Body, Controller, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../../common/errors';
import { parseApiAmount } from '../../common/money';
import { FinancialPost, IdempotencyKey, sendIdempotent } from '../idempotency';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { TransferService } from './transfer.service';

/**
 * @class TransferController
 * @description `POST /transfers`. Maps HTTP to the use case and back; the rules live in `TransferService`.
 */
@Controller('transfers')
export class TransferController {
  constructor(private readonly transfers: TransferService) {}

  @FinancialPost()
  async create(
    @IdempotencyKey() key: string,
    @Body() dto: CreateTransferDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const amount = parseApiAmount(dto.currency, dto.amount);
    if (!amount.isPositive()) {
      throw new AppError(
        'VALIDATION_ERROR',
        'amount must be greater than zero',
      );
    }
    const { response, replayed } = await this.transfers.request(
      {
        fromUserId: dto.fromUserId,
        toUserId: dto.toUserId,
        amount,
        body: dto,
      },
      key,
    );
    return sendIdempotent(res, response, replayed);
  }
}
