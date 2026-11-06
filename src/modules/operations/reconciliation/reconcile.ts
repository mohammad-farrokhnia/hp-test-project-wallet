import type { BankReferenced } from '../../deposit/repositories/deposits.repository';
import type {
  ParsedSettlement,
  SettlementRow,
} from '../../integrations/psp/settlement-csv';

export type MismatchType =
  | 'MISSING_IN_LEDGER'
  | 'MISSING_IN_SETTLEMENT'
  | 'AMOUNT_MISMATCH'
  | 'DUPLICATE_IN_SETTLEMENT'
  | 'UNREADABLE_ROW';

export interface Mismatch {
  readonly type: MismatchType;
  readonly reference: string | null;
  readonly depositId: string | null;
  readonly ourAmountRial: bigint | null;
  readonly theirAmountRial: bigint | null;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ReconcileInput {
  readonly settlement: ParsedSettlement;
  readonly jalaliDay: string;
  readonly creditedOnDay: readonly BankReferenced[];
  readonly byReference: ReadonlyMap<string, BankReferenced>;
  readonly nearStartBefore: Date;
}

export interface ReconcileResult {
  readonly matched: number;
  readonly mismatches: readonly Mismatch[];
}

/**
 * @function reconcile
 * @description Compares the PSP's settlement file for a day with what we credited, by bank reference. Pure: it changes nothing and decides nothing about money.
 * Reported, each with the right type:
 * - `UNREADABLE_ROW`: a row we cannot read, or one dated another day: nothing in the file is skipped silently;
 * - `DUPLICATE_IN_SETTLEMENT`: one reference on several rows; the first row is the one compared;
 * - `MISSING_IN_LEDGER`: the PSP settled a reference no deposit of ours is credited under. `details.deposit` says whether a deposit exists at all
 *   and in what status: a `PENDING` one is a payment the PSP verified that we have not credited;
 * - `AMOUNT_MISMATCH`: both sides have it, for different amounts;
 * - `MISSING_IN_SETTLEMENT`: we credited it that day and the PSP's file does not list it. Within minutes of the day's start it is marked `nearDayStart`:
 *   it may be listed in the previous day's file.
 * A reference whose deposit was credited on another day is not missing: the lookup is by reference, not by day.
 * @param input - the file, the day and our side
 * @returns how many references matched and every mismatch, in a stable order
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const mismatches: Mismatch[] = [];

  for (const u of input.settlement.unreadable) {
    mismatches.push({
      type: 'UNREADABLE_ROW',
      reference: null,
      depositId: null,
      ourAmountRial: null,
      theirAmountRial: null,
      details: { line: u.line, reason: u.reason, raw: u.raw },
    });
  }

  const byRef = new Map<string, SettlementRow[]>();
  for (const row of input.settlement.rows) {
    if (row.jalaliDate !== input.jalaliDay) {
      mismatches.push({
        type: 'UNREADABLE_ROW',
        reference: row.reference,
        depositId: null,
        ourAmountRial: null,
        theirAmountRial: null,
        details: {
          line: row.line,
          reason: 'DATE_MISMATCH',
          expected: input.jalaliDay,
          found: row.jalaliDate,
        },
      });
      continue;
    }
    const rows = byRef.get(row.reference) ?? [];
    rows.push(row);
    byRef.set(row.reference, rows);
  }

  let matched = 0;
  for (const [reference, rows] of byRef) {
    const first = rows[0];
    if (rows.length > 1) {
      mismatches.push({
        type: 'DUPLICATE_IN_SETTLEMENT',
        reference,
        depositId: input.byReference.get(reference)?.id ?? null,
        ourAmountRial: null,
        theirAmountRial: first.amountRial,
        details: {
          count: rows.length,
          lines: rows.map((r) => r.line),
          rowNumbers: rows.map((r) => r.rowNumber),
          amountsRial: rows.map((r) => r.amountRial.toString()),
          amountsDiffer: rows.some((r) => r.amountRial !== first.amountRial),
        },
      });
    }

    const deposit = input.byReference.get(reference);
    if (!deposit || deposit.status !== 'SUCCEEDED') {
      mismatches.push({
        type: 'MISSING_IN_LEDGER',
        reference,
        depositId: deposit?.id ?? null,
        ourAmountRial: null,
        theirAmountRial: first.amountRial,
        details: {
          line: first.line,
          description: first.description,
          deposit: deposit ? { id: deposit.id, status: deposit.status } : null,
        },
      });
    } else if (deposit.creditedRial !== first.amountRial) {
      mismatches.push({
        type: 'AMOUNT_MISMATCH',
        reference,
        depositId: deposit.id,
        ourAmountRial: deposit.creditedRial,
        theirAmountRial: first.amountRial,
        details: { line: first.line, description: first.description },
      });
    } else {
      matched++;
    }
  }

  const listed = new Set(input.settlement.rows.map((r) => r.reference));
  const unlisted = input.creditedOnDay
    .filter((d) => !listed.has(d.reference))
    .sort((a, b) => (a.reference < b.reference ? -1 : 1));
  for (const d of unlisted) {
    mismatches.push({
      type: 'MISSING_IN_SETTLEMENT',
      reference: d.reference,
      depositId: d.id,
      ourAmountRial: d.creditedRial,
      theirAmountRial: null,
      details: {
        completedAt: d.completedAt?.toISOString() ?? null,
        nearDayStart:
          d.completedAt !== null && d.completedAt < input.nearStartBefore,
      },
    });
  }

  return { matched, mismatches };
}
