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
import { AppConfig } from '../../../config/app-config';
import { RabbitConnection } from '../rabbit/rabbit-connection';
import { RabbitModule } from '../rabbit/rabbit.module';
import { RabbitPublisher } from '../rabbit/rabbit-publisher';
import { JobConsumer, JobHandler } from './job-consumer';

export const JOB_HANDLERS = Symbol('JOB_HANDLERS');

/**
 * @class JobConsumers
 * @description Starts one `JobConsumer` per handler at boot; on shutdown stops taking jobs and waits for those in progress.
 */
@Injectable()
export class JobConsumers
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly consumers: JobConsumer[];

  constructor(
    @Inject(JOB_HANDLERS) handlers: JobHandler[],
    connection: RabbitConnection,
    publisher: RabbitPublisher,
    config: AppConfig,
  ) {
    const queues = handlers.map((h) => h.job);
    const twice = queues.find((q, i) => queues.indexOf(q) !== i);
    if (twice) throw new Error(`two handlers for ${twice}`);
    this.consumers = handlers.map(
      (h) =>
        new JobConsumer(connection, publisher, h, {
          queue: h.job,
          ...config.jobs,
        }),
    );
  }

  onApplicationBootstrap(): void {
    for (const c of this.consumers) c.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.consumers.map((c) => c.stop()));
  }
}

/**
 * @class JobsModule
 * @description Worker role: the job consumers. The handlers are listed where the app is assembled, so what consumes what is visible in one place.
 */
@Module({})
export class JobsModule {
  /**
   * @param options.handlers - one per job queue; each from a module in `imports` that exports it
   * @param options.imports - the modules that provide the handlers
   */
  static register(options: {
    handlers: Type<JobHandler>[];
    imports?: ModuleMetadata['imports'];
  }): DynamicModule {
    return {
      module: JobsModule,
      imports: [RabbitModule, ...(options.imports ?? [])],
      providers: [
        {
          provide: JOB_HANDLERS,
          inject: options.handlers,
          useFactory: (...handlers: JobHandler[]) => handlers,
        },
        JobConsumers,
      ],
    };
  }
}
