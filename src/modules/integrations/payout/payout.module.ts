import { Module } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { HttpPayoutClient } from './http-payout.client';
import { PAYOUT_CLIENT } from './payout.port';
import { WebhookVerifier } from './webhook-verifier';

/** The payout port, bound to the HTTP adapter. Tests bind a fake to `PAYOUT_CLIENT` instead. */
@Module({
  providers: [
    {
      provide: PAYOUT_CLIENT,
      inject: [AppConfig],
      useFactory: (c: AppConfig) =>
        new HttpPayoutClient(c.payout.baseUrl, c.http.timeoutMs),
    },
    {
      provide: WebhookVerifier,
      inject: [AppConfig],
      useFactory: (c: AppConfig) => new WebhookVerifier(c.payout.webhookSecret),
    },
  ],
  exports: [PAYOUT_CLIENT, WebhookVerifier],
})
export class PayoutModule {}
