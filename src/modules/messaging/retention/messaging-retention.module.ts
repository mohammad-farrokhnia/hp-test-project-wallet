import { Module } from '@nestjs/common';
import { InboxService } from '../inbox/inbox.service';
import { OutboxRepository } from '../outbox/outbox.repository';
import { MessagingRetentionJob } from './messaging-retention.job';

/** Worker role: the hourly purge of delivered outbox rows and old inbox ids. */
@Module({
  providers: [OutboxRepository, InboxService, MessagingRetentionJob],
})
export class MessagingRetentionModule {}
