import { Module } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { HttpPayoutClient } from './http-payout.client';
import { PAYOUT_CLIENT } from './payout.port';

/** The payout port, bound to the HTTP adapter. Tests bind a fake to `PAYOUT_CLIENT` instead. */
@Module({
  providers: [
    {
      provide: PAYOUT_CLIENT,
      inject: [AppConfig],
      useFactory: (c: AppConfig) =>
        new HttpPayoutClient(c.payout.baseUrl, c.http.timeoutMs),
    },
  ],
  exports: [PAYOUT_CLIENT],
})
export class PayoutModule {}
