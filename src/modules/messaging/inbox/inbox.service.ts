import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';

/**
 * @class InboxService
 * @description Consumer-side de-duplication. Delivery from RabbitMQ is at least once, so a consumer records each message id in the same transaction as its effect:
 * the primary key `(consumer, message_id)` lets exactly one of any number of deliveries through, and a rolled-back effect leaves no record, so the retry runs it again.
 */
@Injectable()
export class InboxService {
  /**
   * @function markProcessed
   * @param tx - the consumer's transaction, the one that also applies the effect
   * @param consumer - the consumer's name; ids are per consumer, so two consumers can each handle one message
   * @param messageId - the envelope's `messageId`
   * @returns true the first time; false when this consumer already handled the message
   */
  async markProcessed(
    tx: Tx,
    consumer: string,
    messageId: string,
  ): Promise<boolean> {
    const res = await db(tx)
      .insertInto('inbox')
      .values({ consumer, message_id: messageId })
      .onConflict((oc) => oc.columns(['consumer', 'message_id']).doNothing())
      .executeTakeFirst();
    return res.numInsertedOrUpdatedRows === 1n;
  }

  /**
   * @function deleteOlderThan
   * @description Deletes up to `limit` ids recorded more than `days` ago, oldest first; `SKIP LOCKED` as for every purge.
   * @returns how many ids were deleted
   */
  async deleteOlderThan(tx: Tx, days: number, limit: number): Promise<number> {
    const { rows } = await sql<{ message_id: string }>`
      WITH doomed AS (
        SELECT consumer, message_id FROM inbox
         WHERE processed_at < now() - make_interval(days => ${days})
         ORDER BY processed_at
         LIMIT ${limit}
           FOR UPDATE SKIP LOCKED
      )
      DELETE FROM inbox i
       USING doomed
       WHERE i.consumer = doomed.consumer AND i.message_id = doomed.message_id
      RETURNING i.message_id`.execute(db(tx));
    return rows.length;
  }
}
