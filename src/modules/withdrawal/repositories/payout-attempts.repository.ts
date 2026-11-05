import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';

export type AttemptOutcome =
  'ACCEPTED' | 'REPLAYED' | 'REJECTED' | 'AMBIGUOUS' | 'MISMATCH';

/**
 * @class PayoutAttemptsRepository
 * @description `payout_attempts`: every submit, opened BEFORE the HTTP call,
 * so a crash mid-call still leaves a record of what may have been sent.
 */
@Injectable()
export class PayoutAttemptsRepository {
  async open(
    tx: Tx,
    withdrawalId: string,
    attemptNo: number,
    requestBody: Record<string, unknown>,
  ): Promise<void> {
    await db(tx)
      .insertInto('payout_attempts')
      .values({
        withdrawal_id: withdrawalId,
        attempt_no: attemptNo,
        request_body: JSON.stringify(requestBody),
      })
      .execute();
  }

  async close(
    tx: Tx,
    a: {
      withdrawalId: string;
      attemptNo: number;
      outcome: AttemptOutcome;
      httpStatus: number | null;
      error: string | null;
      responseBody: unknown;
    },
  ): Promise<void> {
    await db(tx)
      .updateTable('payout_attempts')
      .set({
        finished_at: sql<Date>`now()`,
        outcome: a.outcome,
        http_status: a.httpStatus,
        error: a.error,
        response_body:
          a.responseBody === null || a.responseBody === undefined
            ? null
            : JSON.stringify(a.responseBody),
      })
      .where('withdrawal_id', '=', a.withdrawalId)
      .where('attempt_no', '=', a.attemptNo)
      .execute();
  }

  /**
   * @function inFlight
   * @description True while an unfinished attempt is younger than the lease:
   * a call may still be running. Past the lease its process is presumed dead and the same requestId may be sent again.
   */
  async inFlight(
    tx: Tx,
    withdrawalId: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const row = await db(tx)
      .selectFrom('payout_attempts')
      .select('attempt_no')
      .where('withdrawal_id', '=', withdrawalId)
      .where('finished_at', 'is', null)
      .where(
        sql<boolean>`started_at > now() - make_interval(secs => ${leaseSeconds})`,
      )
      .executeTakeFirst();
    return row !== undefined;
  }
}
