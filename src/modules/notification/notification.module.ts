import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger';
import { MessagingModule } from '../messaging';
import { NotificationHandler } from './notification.handler';
import { NotificationsRepository } from './notifications.repository';

/** The consumer of balance events: loaded by the worker, which lists `NotificationHandler` in `JobsModule.register`. */
@Module({
  imports: [LedgerModule, MessagingModule],
  providers: [NotificationHandler, NotificationsRepository],
  exports: [NotificationHandler, NotificationsRepository],
})
export class NotificationModule {}
