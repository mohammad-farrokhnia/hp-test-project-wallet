import { Body, Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../../common/errors';
import { isUuid } from '../../common/ids';
import { parseApiAmount } from '../../common/money';
import { FinancialPost, IdempotencyKey, sendIdempotent } from '../idempotency';
import { DepositService } from './deposit.service';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { DepositView, toDepositView } from './dto/deposit.mapper';

/**
 * @class DepositController
 * @description `POST /deposits` and `GET /deposits/:id`.
 * Maps HTTP to the use case and back; the rules live in `DepositService`.
 */
@Controller('deposits')
export class DepositController {
  constructor(private readonly deposits: DepositService) {}

  @FinancialPost()
  async create(
    @IdempotencyKey() key: string,
    @Body() dto: CreateDepositDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const { response, replayed } = await this.deposits.create(
      {
        userId: dto.userId,
        amount: parseApiAmount('IRT', dto.amount),
        body: dto,
      },
      key,
    );
    return sendIdempotent(res, response, replayed);
  }

  /** Unknown and malformed ids alike are 404: there is no such deposit. */
  @Get(':id')
  async get(@Param('id') id: string): Promise<DepositView> {
    const d = isUuid(id) ? await this.deposits.get(id) : null;
    if (!d) throw new AppError('NOT_FOUND', 'Deposit not found');
    return toDepositView(d);
  }
}
