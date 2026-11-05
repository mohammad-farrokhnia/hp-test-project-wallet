import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { TehranDay } from '../../../common/time/tehran-day';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';

export interface DailyUsage {
  readonly usedRial: bigint;
  readonly capRial: bigint;
}

/**
 * @class DailyLimitRepository
 * @description The daily withdrawal limit as a reserved counter per user and Tehran day:
 * `withdrawal_daily_usage`. Last in the lock order: idempotency key → withdrawal → accounts → this row.
 */
@Injectable()
export class DailyLimitRepository {
  /**
   * @function reserve
   * @description Adds `amountRial` to the day's usage if it stays within the cap.
   * The day's row is created on first use with today's cap, so a config change never rewrites a day already in progress.
   * The check and the increment are one UPDATE under the row lock, so concurrent requests can't both pass the check;
   * `CHECK (used_rial <= cap_rial)` backs it up.
   * @param tx - the request's transaction
   * @returns true when reserved, false when it would pass the cap
   */
  async reserve(
    tx: Tx,
    r: { userId: string; day: TehranDay; amountRial: bigint; capRial: bigint },
  ): Promise<boolean> {
    await db(tx)
      .insertInto('withdrawal_daily_usage')
      .values({ user_id: r.userId, day: r.day, cap_rial: r.capRial })
      .onConflict((oc) => oc.columns(['user_id', 'day']).doNothing())
      .execute();
    const updated = await db(tx)
      .updateTable('withdrawal_daily_usage')
      .set({ used_rial: sql`used_rial + ${r.amountRial}` })
      .where('user_id', '=', r.userId)
      .where('day', '=', r.day)
      .where(sql<boolean>`used_rial + ${r.amountRial} <= cap_rial`)
      .returning('used_rial')
      .executeTakeFirst();
    return updated !== undefined;
  }

  /**
   * @function release
   * @description Gives `amountRial` back to the day it was reserved on (a withdrawal that failed: no money left).
   * The CHECK refuses going below zero, which would mean releasing twice.
   * @throws {Error} when no usage row exists for that day (a release without a reserve)
   */
  async release(
    tx: Tx,
    r: { userId: string; day: TehranDay; amountRial: bigint },
  ): Promise<void> {
    const res = await db(tx)
      .updateTable('withdrawal_daily_usage')
      .set({ used_rial: sql`used_rial - ${r.amountRial}` })
      .where('user_id', '=', r.userId)
      .where('day', '=', r.day)
      .executeTakeFirst();
    if (res.numUpdatedRows !== 1n) {
      throw new Error(`no daily usage for ${r.userId} on ${r.day} to release`);
    }
  }

  /** The day's usage; zero used and no cap when nothing was reserved yet. */
  async usage(
    tx: Tx,
    userId: string,
    day: TehranDay,
  ): Promise<DailyUsage | null> {
    const row = await db(tx)
      .selectFrom('withdrawal_daily_usage')
      .select(['used_rial', 'cap_rial'])
      .where('user_id', '=', userId)
      .where('day', '=', day)
      .executeTakeFirst();
    return row
      ? { usedRial: BigInt(row.used_rial), capRial: BigInt(row.cap_rial) }
      : null;
  }
}
