import { DynamicModule, Module, Type } from '@nestjs/common';
import { ErrorsModule } from './common/errors';
import { GuardsModule } from './common/guards';
import { LoggingModule } from './common/logging';
import { ValidationModule } from './common/validation';
import { ConfigModule } from './config/config.module';
import { Env } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import {
  IdempotencyCleanupModule,
  IdempotencyModule,
} from './modules/idempotency';
import {
  DepositApiModule,
  DepositDueWork,
  DepositModule,
  DepositSyncHandler,
  DepositWatchdog,
} from './modules/deposit';
import { InboundEventsRetentionModule } from './modules/integrations/inbound-events';
import { LedgerModule } from './modules/ledger';
import {
  JobsModule,
  MessagingModule,
  MessagingRetentionModule,
  OutboxRelayModule,
  RabbitModule,
} from './modules/messaging';
import {
  NotificationHandler,
  NotificationModule,
} from './modules/notification';
import { InvariantsCheckModule, OperationsModule } from './modules/operations';
import { SchedulerModule } from './modules/scheduler';
import { TransferApiModule } from './modules/transfer';
import { WalletModule } from './modules/wallet';
import {
  WithdrawalApiModule,
  WithdrawalDueWork,
  WithdrawalModule,
  WithdrawalReviewSource,
  WithdrawalSubmitHandler,
  WithdrawalSyncHandler,
} from './modules/withdrawal';

export type AppRole = Env['APP_ROLE'];

const SHARED_MODULES: Type[] = [
  ConfigModule,
  LoggingModule,
  ErrorsModule,
  DatabaseModule,
  LedgerModule,
  IdempotencyModule,
  MessagingModule,
  HealthModule,
];

const API_MODULES: Type[] = [
  ValidationModule,
  GuardsModule,
  OperationsModule,
  WalletModule,
  DepositApiModule,
  WithdrawalApiModule,
  TransferApiModule,
];

const WORKER_MODULES: (Type | DynamicModule)[] = [
  IdempotencyCleanupModule,
  InboundEventsRetentionModule,
  MessagingRetentionModule,
  InvariantsCheckModule,
  RabbitModule,
  OutboxRelayModule,
  JobsModule.register({
    handlers: [
      WithdrawalSubmitHandler,
      WithdrawalSyncHandler,
      DepositSyncHandler,
      NotificationHandler,
    ],
    imports: [WithdrawalModule, DepositModule, NotificationModule],
  }),
  SchedulerModule.register({
    sources: [
      WithdrawalDueWork,
      WithdrawalReviewSource,
      DepositDueWork,
      DepositWatchdog,
    ],
    imports: [WithdrawalModule, DepositModule],
  }),
];

/**
 * @class AppModule
 * @description Root module. `forRole` assembles the process for its `APP_ROLE`: `api` adds the HTTP edge, `worker` adds the background modules, `all` adds both. Every role serves `/health` and `/ready` for its probes and nothing else over HTTP unless it is an api role.
 */
@Module({})
export class AppModule {
  /**
   * @function forRole
   * @param role - the validated `APP_ROLE`
   * @returns the root module for that role
   */
  static forRole(role: AppRole): DynamicModule {
    const appRoleModules = {
      worker: WORKER_MODULES,
      api: API_MODULES,
      all: [...API_MODULES, ...WORKER_MODULES],
    };
    return {
      module: AppModule,
      imports: [...SHARED_MODULES, ...appRoleModules[role]],
    };
  }
}
