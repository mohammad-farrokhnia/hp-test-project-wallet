import { Controller, Get, Param, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { AppError } from '../../common/errors';
import { isValidUserId, USER_ID_MESSAGE } from '../../common/validation';
import { parseLimit } from './domain/history-query';
import { HistoryResponse, WalletResponse } from './wallet.mapper';
import { WalletService } from './wallet.service';

/** `?limit&cursor`; any other parameter is refused by the validation pipe. */
export class HistoryQueryDto {
  @IsOptional() @IsString() limit?: string;
  @IsOptional() @IsString() cursor?: string;
}

function checkedUserId(userId: string): string {
  if (!isValidUserId(userId)) {
    throw new AppError('VALIDATION_ERROR', USER_ID_MESSAGE);
  }
  return userId;
}

/**
 * @class WalletController
 * @description `GET /wallets/:userId` and `GET /wallets/:userId/ledger`. Reads only.
 */
@Controller('wallets')
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Get(':userId')
  getWallet(@Param('userId') userId: string): Promise<WalletResponse> {
    return this.wallets.getWallet(checkedUserId(userId));
  }

  @Get(':userId/ledger')
  getHistory(
    @Param('userId') userId: string,
    @Query() query: HistoryQueryDto,
  ): Promise<HistoryResponse> {
    return this.wallets.getHistory(checkedUserId(userId), {
      cursor: query.cursor,
      limit: parseLimit(query.limit),
    });
  }
}
