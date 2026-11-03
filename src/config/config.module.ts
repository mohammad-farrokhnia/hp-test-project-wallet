import { Global, Module } from '@nestjs/common';
import { AppConfig, loadConfig } from './app-config';

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => loadConfig() }],
  exports: [AppConfig],
})
export class ConfigModule {}
