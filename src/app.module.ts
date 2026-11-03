import { Module } from '@nestjs/common';
import { ErrorsModule } from './common/errors';
import { LoggingModule } from './common/logging';
import { ValidationModule } from './common/validation';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    ErrorsModule,
    ValidationModule,
    HealthModule,
  ],
})
export class AppModule {}
