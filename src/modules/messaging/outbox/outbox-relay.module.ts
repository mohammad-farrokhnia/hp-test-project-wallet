import {
  Inject,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { TransactionRunner } from '../../../database/transaction-runner';
import { RabbitModule } from '../rabbit/rabbit.module';
import { RabbitPublisher } from '../rabbit/rabbit-publisher';
import { OutboxRelay } from './outbox-relay';
import { OutboxRepository } from './outbox.repository';

/**
 * @class OutboxRelayModule
 * @description Worker role only: runs the outbox relay from boot to shutdown. Every worker runs one; they share the work through `SKIP LOCKED` claims.
 */
@Module({
  imports: [RabbitModule],
  providers: [
    OutboxRepository,
    {
      provide: OutboxRelay,
      inject: [TransactionRunner, OutboxRepository, RabbitPublisher, AppConfig],
      useFactory: (
        runner: TransactionRunner,
        outbox: OutboxRepository,
        publisher: RabbitPublisher,
        c: AppConfig,
      ) => new OutboxRelay(runner, outbox, publisher, c.outbox),
    },
  ],
})
export class OutboxRelayModule
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  constructor(@Inject(OutboxRelay) private readonly relay: OutboxRelay) {}

  onApplicationBootstrap(): void {
    this.relay.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.relay.stop();
  }
}
