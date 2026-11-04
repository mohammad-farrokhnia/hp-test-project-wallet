import { Body, Controller, Headers, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../../../common/errors';
import { InternalOnly } from '../../../common/guards';
import { parseApiAmount } from '../../../common/money';
import {
  FinancialPost,
  IdempotencyKey,
  sendIdempotent,
} from '../../idempotency';
import { AdjustmentsService } from './adjustments.service';
import { CreateAdjustmentDto } from './create-adjustment.dto';

export const OPERATOR_HEADER = 'x-operator-id';

/** 1–128 printable ASCII characters; mirrors `adjustments_actor_length`. */
const OPERATOR_FORMAT = /^[ -~]{1,128}$/;

/**
 * @class AdjustmentsController
 * @description `POST /internal/adjustments`: an operator credits a user. The internal key is checked first, then the Idempotency-Key, then the body.
 */
@Controller('internal')
@InternalOnly()
export class AdjustmentsController {
  constructor(private readonly adjustments: AdjustmentsService) {}

  @FinancialPost('adjustments')
  async create(
    @IdempotencyKey() key: string,
    @Body() dto: CreateAdjustmentDto,
    @Headers(OPERATOR_HEADER) operator: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const amount = parseApiAmount(dto.currency, dto.amount);
    if (!amount.isPositive()) {
      throw new AppError(
        'VALIDATION_ERROR',
        'amount must be greater than zero',
      );
    }
    if (operator !== undefined && !OPERATOR_FORMAT.test(operator)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'X-Operator-Id must be 1-128 printable ASCII characters',
      );
    }

    const { response, replayed } = await this.adjustments.create(
      {
        userId: dto.userId,
        amount,
        reason: dto.reason,
        actor: operator ?? null,
        body: dto,
      },
      key,
    );
    return sendIdempotent(res, response, replayed);
  }
}
