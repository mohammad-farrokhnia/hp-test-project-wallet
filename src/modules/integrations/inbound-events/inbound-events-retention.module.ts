import { Module } from '@nestjs/common';
import { InboundEventsRetentionJob } from './inbound-events-retention.job';
import { InboundEvents } from './inbound-events.service';

/** Worker role: the daily-scale purge of old recorded callbacks and webhooks. */
@Module({
  providers: [InboundEvents, InboundEventsRetentionJob],
})
export class InboundEventsRetentionModule {}
