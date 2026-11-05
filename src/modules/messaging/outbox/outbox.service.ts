import { Injectable } from '@nestjs/common';
import { Tx } from '../../../database/transaction-runner';
import { OutboxExchange } from '../topology';
import { OutboxRepository } from './outbox.repository';

/** A message to publish once the caller's transaction commits. */
export interface OutboxMessage {
  readonly exchange: OutboxExchange;
  readonly routingKey: string;
  readonly aggregate: { readonly type: string; readonly id: string };
  readonly payload: Readonly<Record<string, string>>;
}

/**
 * @class OutboxService
 * @description Writes a message in the caller's transaction .
 */
@Injectable()
export class OutboxService {
  constructor(private readonly outbox: OutboxRepository) {}

  /**
   * @function add
   * @param tx - the caller's business transaction
   * @param message - where to send it, what it is about, its ids
   * @returns the outbox id, which is also the message id
   */
  add(tx: Tx, message: OutboxMessage): Promise<bigint> {
    return this.outbox.insert(tx, {
      exchange: message.exchange,
      routingKey: message.routingKey,
      aggregateType: message.aggregate.type,
      aggregateId: message.aggregate.id,
      payload: message.payload,
    });
  }
}
