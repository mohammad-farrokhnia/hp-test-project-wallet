import { Module } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { HttpPspClient } from './http-psp.client';
import { PSP_CLIENT } from './psp.port';

/** The PSP port, bound to the HTTP adapter. Tests bind a fake to `PSP_CLIENT` instead. */
@Module({
  providers: [
    {
      provide: PSP_CLIENT,
      inject: [AppConfig],
      useFactory: (c: AppConfig) =>
        new HttpPspClient(c.psp.baseUrl, c.http.timeoutMs),
    },
  ],
  exports: [PSP_CLIENT],
})
export class PspModule {}
