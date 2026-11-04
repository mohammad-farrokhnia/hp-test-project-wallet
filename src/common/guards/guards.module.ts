import { Module } from '@nestjs/common';
import { InternalApiKeyNotice } from './internal-api-key.guard';

/** API role: the boot-time notice for the internal API key. */
@Module({ providers: [InternalApiKeyNotice] })
export class GuardsModule {}
