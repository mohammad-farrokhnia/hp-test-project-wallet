import { Module } from '@nestjs/common';
import { InboxService } from './inbox/inbox.service';
import { OutboxRepository } from './outbox/outbox.repository';
import { OutboxService } from './outbox/outbox.service';

/** Every role: the outbox writer and the inbox de-duplicator. Publishing to RabbitMQ is the worker's (`RabbitModule`). */
@Module({
  providers: [OutboxRepository, OutboxService, InboxService],
  exports: [OutboxService, InboxService],
})
export class MessagingModule {}
