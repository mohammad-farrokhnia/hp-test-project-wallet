import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { IdempotencyExempt } from '../../idempotency';
import { PspCallbackService } from './psp-callback.service';

/**
 * @class PspCallbackController
 * @description `POST /webhooks/psp/callback/:depositId`: record, schedule a sync, always answer 200.
 * The PSP never retries a failure, so an error here would only lose the hint. Exempt from Idempotency-Key:
 * the PSP never sends one, and a repeat only schedules another harmless pull.
 */
@Controller('webhooks/psp')
export class PspCallbackController {
  constructor(private readonly callbacks: PspCallbackService) {}

  @Post('callback/:depositId')
  @HttpCode(200)
  @IdempotencyExempt(
    'PSP callback: never sends the header; a repeat only schedules another pull',
  )
  async receive(
    @Param('depositId') depositId: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ received: true }> {
    await this.callbacks.receive(
      depositId,
      req.rawBody ?? Buffer.alloc(0),
      req.headers,
    );
    return { received: true };
  }
}
