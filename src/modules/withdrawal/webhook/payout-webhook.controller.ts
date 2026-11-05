import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { IdempotencyExempt } from '../../idempotency';
import { PayoutWebhookService } from './payout-webhook.service';

/**
 * @class PayoutWebhookController
 * @description `POST /webhooks/payout`: verify, record, schedule a sync, answer 200. Exempt from Idempotency-Key:
 * the provider never sends one, and a repeat only schedules another harmless pull.
 */
@Controller('webhooks')
export class PayoutWebhookController {
  constructor(private readonly webhooks: PayoutWebhookService) {}

  @Post('payout')
  @HttpCode(200)
  @IdempotencyExempt(
    'provider webhook: signed, never sends the header; a repeat only schedules another GET',
  )
  async receive(
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ received: true }> {
    await this.webhooks.receive(req.rawBody ?? Buffer.alloc(0), req.headers);
    return { received: true };
  }
}
