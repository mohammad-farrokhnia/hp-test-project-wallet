import { Injectable } from '@nestjs/common';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';
import { OutboxExchange } from '../topology';

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
  /**
   * @function add
   * @param tx - the caller's business transaction
   * @param message - where to send it, what it is about, its ids
   * @returns the outbox id, which is also the message id
   */
  async add(tx: Tx, message: OutboxMessage): Promise<bigint> {
    const row = await db(tx)
      .insertInto('outbox')
      .values({
        exchange: message.exchange,
        routing_key: message.routingKey,
        aggregate_type: message.aggregate.type,
        aggregate_id: message.aggregate.id,
        payload: JSON.stringify(message.payload),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return BigInt(row.id);
  }
}
