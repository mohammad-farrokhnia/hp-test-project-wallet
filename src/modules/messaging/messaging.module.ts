import { Module } from '@nestjs/common';
import { OutboxService } from './outbox/outbox.service';

/** Every role: the outbox writer. Publishing to RabbitMQ is the worker's (`RabbitModule`). */
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class MessagingModule {}
