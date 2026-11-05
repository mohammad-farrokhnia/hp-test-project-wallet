import { Module } from '@nestjs/common';
import { OutboxRepository } from './outbox/outbox.repository';
import { OutboxService } from './outbox/outbox.service';

/** Every role: the outbox writer. Publishing to RabbitMQ is the worker's (`RabbitModule`). */
@Module({
  providers: [OutboxRepository, OutboxService],
  exports: [OutboxService],
})
export class MessagingModule {}
