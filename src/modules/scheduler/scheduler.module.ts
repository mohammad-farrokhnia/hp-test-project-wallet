import {
  DynamicModule,
  Inject,
  Injectable,
  Module,
  ModuleMetadata,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Type,
} from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { TransactionRunner } from '../../database/transaction-runner';
import { RabbitModule, RabbitPublisher } from '../messaging';
import { DueWorkSource } from './due-work';
import { Sweeper } from './sweeper';

export const DUE_WORK_SOURCES = Symbol('DUE_WORK_SOURCES');

/** Runs the sweeper from boot to shutdown. */
@Injectable()
export class SweeperRunner
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly sweeper: Sweeper;

  constructor(
    @Inject(DUE_WORK_SOURCES) sources: DueWorkSource[],
    runner: TransactionRunner,
    publisher: RabbitPublisher,
    config: AppConfig,
  ) {
    this.sweeper = new Sweeper(runner, publisher, sources, config.sweeper);
  }

  onApplicationBootstrap(): void {
    this.sweeper.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.sweeper.stop();
  }
}

/**
 * @class SchedulerModule
 * @description The sources are listed where the app is assembled;
 * the scheduler knows only the `DueWorkSource` interface, never withdrawal's or deposit's tables.
 */
@Module({})
export class SchedulerModule {
  /**
   * @param options.sources - the modules' `DueWorkSource` implementations
   * @param options.imports - the modules that provide them
   */
  static register(options: {
    sources: Type<DueWorkSource>[];
    imports?: ModuleMetadata['imports'];
  }): DynamicModule {
    return {
      module: SchedulerModule,
      imports: [RabbitModule, ...(options.imports ?? [])],
      providers: [
        {
          provide: DUE_WORK_SOURCES,
          inject: options.sources,
          useFactory: (...sources: DueWorkSource[]) => sources,
        },
        SweeperRunner,
      ],
    };
  }
}
