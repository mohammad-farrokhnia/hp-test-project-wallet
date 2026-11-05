import { Body, Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../../common/errors';
import { parseApiAmount } from '../../common/money';
import { FinancialPost, IdempotencyKey, sendIdempotent } from '../idempotency';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import { toWithdrawalView, WithdrawalView } from './dto/withdrawal.mapper';
import { WithdrawalService } from './withdrawal.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const w = UUID.test(id) ? await this.withdrawals.get(id) : null;
    if (!w) throw new AppError('NOT_FOUND', 'Withdrawal not found');
    return toWithdrawalView(w);
  }
}
