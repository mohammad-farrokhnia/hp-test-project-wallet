import { sql } from 'kysely';
import { db } from '../../database/kysely';
import type { Tx } from '../../database/transaction-runner';

/** A calendar day in Asia/Tehran, `YYYY-MM-DD`. */
export type TehranDay = string;

/**
 * @function tehranDay
 * @description The Tehran calendar day from the DATABASE clock, so every instance agrees on "today" however its own clock drifts.
 * Returned as `YYYY-MM-DD` text, not a JS `Date`, which node-postgres would shift into the server's time zone.
 * @param tx - any transaction
 * @param at - the instant to convert; defaults to the database's `now()` (tests pass boundaries)
 * @returns the day
 */
export async function tehranDay(tx: Tx, at?: Date): Promise<TehranDay> {
  const instant =
    at === undefined ? sql`now()` : sql`${at.toISOString()}::timestamptz`;
  const { rows } = await sql<{ day: string }>`
    SELECT to_char(${instant} AT TIME ZONE 'Asia/Tehran', 'YYYY-MM-DD') AS day`.execute(
    db(tx),
  );
  return rows[0].day;
}
