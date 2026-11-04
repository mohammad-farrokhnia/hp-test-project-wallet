import { DynamicModule, Module, Type } from '@nestjs/common';
import { ErrorsModule } from './common/errors';
import { LoggingModule } from './common/logging';
import { ValidationModule } from './common/validation';
import { ConfigModule } from './config/config.module';
import { Env } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { LedgerModule } from './modules/ledger';

export type AppRole = Env['APP_ROLE'];

const SHARED_MODULES: Type[] = [
  ConfigModule,
  LoggingModule,
  ErrorsModule,
  DatabaseModule,
  LedgerModule,
  HealthModule,
];

const API_MODULES: Type[] = [ValidationModule];

const WORKER_MODULES: Type[] = [];

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
