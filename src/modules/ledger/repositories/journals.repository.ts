import { Injectable } from '@nestjs/common';
import { db } from '../../../database/kysely';
import { Tx } from '../../../database/transaction-runner';
import { JournalInput, PlannedPosting, REF_TYPE_OF } from '../domain/journal';

/**
 * @class JournalsRepository
 * @description Appends to `journals` and `postings`. Both tables are append-only (triggers reject UPDATE and DELETE), so this class only inserts and reads.
 */
@Injectable()
export class JournalsRepository {
  /**
   * @function insertJournal
   * @description Inserts the journal unless `(kind, ref_type, ref_id)` is already booked. A concurrent insert of the same key makes this statement wait for that transaction, then skip.
   * @param tx - the caller's transaction
   * @param journal - the journal to book
   * @returns the new journal id, or `null` when the key was already booked
   */
  async insertJournal(tx: Tx, journal: JournalInput): Promise<bigint | null> {
    const row = await db(tx)
      .insertInto('journals')
      .values({
        kind: journal.kind,
        ref_type: REF_TYPE_OF[journal.kind],
        ref_id: journal.refId,
        currency: journal.currency,
        description: journal.description ?? null,
        reverses_journal_id: journal.reversesJournalId ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['kind', 'ref_type', 'ref_id']).doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    return row ? BigInt(row.id) : null;
  }

  /**
   * @function findJournalId
   * @param tx - the caller's transaction
   * @param journal - kind and ref of the journal
   * @returns the id of the journal booked for that event
   * @throws {Error} when none exists (only called after a conflict proved one does)
   */
  async findJournalId(tx: Tx, journal: JournalInput): Promise<bigint> {
    const row = await db(tx)
      .selectFrom('journals')
      .select('id')
      .where('kind', '=', journal.kind)
      .where('ref_type', '=', REF_TYPE_OF[journal.kind])
      .where('ref_id', '=', journal.refId)
      .executeTakeFirstOrThrow();
    return BigInt(row.id);
  }

  /**
   * @function insertPostings
   * @description One row per line, in line order, each carrying the balance right after it.
   * @param tx - the caller's transaction
   * @param journalId - the journal they belong to
   * @param postings - planned postings from `planPostings`
   */
  async insertPostings(
    tx: Tx,
    journalId: bigint,
    postings: readonly PlannedPosting[],
  ): Promise<void> {
    await db(tx)
      .insertInto('postings')
      .values(
        postings.map((p) => ({
          journal_id: journalId,
          account_id: p.account.id,
          user_id: p.account.userId,
          account_kind: p.account.kind,
          currency: p.account.currency,
          amount_minor: p.amount.minor,
          balance_after_minor: p.balanceAfter.minor,
        })),
      )
      .execute();
  }
}
