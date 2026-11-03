import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../config/app-config';
import { createDataSource } from './data-source';
import { TransactionRunner } from './transaction-runner';

@Global()
@Module({
  providers: [
    {
      provide: DataSource,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => createDataSource(config).initialize(),
    },
    {
      provide: TransactionRunner,
      inject: [DataSource, AppConfig],
      useFactory: (ds: DataSource, config: AppConfig) =>
        new TransactionRunner(ds, {
          lockTimeoutMs: config.db.lockTimeoutMs,
          statementTimeoutMs: config.db.statementTimeoutMs,
        }),
    },
  ],
  exports: [DataSource, TransactionRunner],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DataSource) private readonly ds: DataSource) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.ds.isInitialized) await this.ds.destroy();
  }
}
