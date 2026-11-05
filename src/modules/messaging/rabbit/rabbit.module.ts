import {
  Inject,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { TOPOLOGY } from '../topology';
import { RabbitConnection } from './rabbit-connection';
import { RabbitPublisher } from './rabbit-publisher';

/**
 * @class RabbitModule
 * @description Worker role only: the api writes outbox rows and never talks to RabbitMQ. Connects in the background at boot (the topology is declared on every connect) and closes on shutdown.
 */
@Module({
  providers: [
    {
      provide: RabbitConnection,
      inject: [AppConfig],
      useFactory: (c: AppConfig) =>
        new RabbitConnection(c.rabbit.url, TOPOLOGY),
    },
    {
      provide: RabbitPublisher,
      inject: [RabbitConnection, AppConfig],
      useFactory: (conn: RabbitConnection, c: AppConfig) =>
        new RabbitPublisher(conn, {
          timeoutMs: c.rabbit.publishTimeoutMs,
          retries: c.rabbit.publishRetries,
          backoffMs: 200,
        }),
    },
  ],
  exports: [RabbitConnection, RabbitPublisher],
})
export class RabbitModule
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  constructor(
    @Inject(RabbitConnection) private readonly connection: RabbitConnection,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.connection.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}
