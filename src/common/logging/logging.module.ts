import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfig } from '../../config/app-config';
import { buildPinoHttpOptions } from './logging.config';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: buildPinoHttpOptions(config),
      }),
    }),
  ],
})
export class LoggingModule {}
