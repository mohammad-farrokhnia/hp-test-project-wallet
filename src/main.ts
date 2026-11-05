import { Logger } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { APP_OPTIONS, configureBodyParsing } from './common/http';
import { AppConfig, loadConfig } from './config/app-config';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRole(loadConfig().role),
    { ...APP_OPTIONS, bufferLogs: true },
  );
  configureBodyParsing(app);
  app.useLogger(app.get(PinoLogger));
  app.enableShutdownHooks();
  const config = app.get(AppConfig);
  await app.listen(config.http.port);
  Logger.log(
    `[${config.role}] HTTP listening on :${config.http.port}`,
    'Bootstrap',
  );
}
void bootstrap();
