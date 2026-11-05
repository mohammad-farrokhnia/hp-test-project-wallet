import { Body, Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../../common/errors';
import { isUuid } from '../../common/ids';
import { parseApiAmount } from '../../common/money';
import { FinancialPost, IdempotencyKey, sendIdempotent } from '../idempotency';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import { toWithdrawalView, WithdrawalView } from './dto/withdrawal.mapper';
import { WithdrawalService } from './withdrawal.service';

/**
 * @class WithdrawalController
 * @description `POST /withdrawals` and `GET /withdrawals/:id`.
 * Maps HTTP to the use case and back; the rules live in `WithdrawalService`.
 */
@Controller('withdrawals')
export class WithdrawalController {
  constructor(private readonly withdrawals: WithdrawalService) {}

  @FinancialPost()
  async create(
    @IdempotencyKey() key: string,
    @Body() dto: CreateWithdrawalDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const { response, replayed } = await this.withdrawals.request(
      {
        userId: dto.userId,
        amount: parseApiAmount(dto.currency, dto.amount),
        destination: dto.destination,
        body: dto,
      },
      key,
    );
    return sendIdempotent(res, response, replayed);
  }

  /** Unknown and malformed ids alike are 404: there is no such withdrawal. */
  @Get(':id')
  async get(@Param('id') id: string): Promise<WithdrawalView> {
    const w = isUuid(id) ? await this.withdrawals.get(id) : null;
    if (!w) throw new AppError('NOT_FOUND', 'Withdrawal not found');
    return toWithdrawalView(w);
  }
}
