import type { BankReferenced } from '../../deposit/repositories/deposits.repository';
import type {
  SettlementRow,
  UnreadableRow,
} from '../../integrations/psp/settlement-csv';
import { reconcile, ReconcileInput } from './reconcile';

const DAY = '1405/08/15';
const START = new Date('2026-11-05T20:30:00Z');
const NEAR_START = new Date(START.getTime() + 5 * 60_000);

let line = 1;
const settled = (
  reference: string,
  amount: bigint,
  over: Partial<SettlementRow> = {},
): SettlementRow => ({
  line: ++line,
  rowNumber: String(line - 1),
  jalaliDate: DAY,
  reference,
  referenceRaw: reference.padStart(13, '0'),
  amountRial: amount,
  description: `پرداخت اینترنتی A0${reference}`,
  ...over,
});
const credited = (
  reference: string,
  amount: bigint,
  over: Partial<BankReferenced> = {},
): BankReferenced => ({
  id: `dep-${reference}`,
  bankReference: reference,
  reference,
  status: 'SUCCEEDED',
  creditedRial: amount,
  completedAt: new Date('2026-11-06T10:00:00Z'),
  ...over,
});
const unreadable = (over: Partial<UnreadableRow> = {}): UnreadableRow => ({
  line: ++line,
  reason: 'BAD_AMOUNT',
  raw: '1,x,2,3,4,5',
  ...over,
});

/** The input of a day: `file` is what the PSP lists, `ours` what we credited that day, `elsewhere` our other deposits that appear in the file. */
function day(
  file: SettlementRow[],
  ours: BankReferenced[],
  elsewhere: BankReferenced[] = [],
  bad: UnreadableRow[] = [],
): ReconcileInput {
  const byReference = new Map(
    [...ours, ...elsewhere].map((d) => [d.reference, d] as const),
  );
  return {
    settlement: { rows: file, unreadable: bad },
    jalaliDay: DAY,
    creditedOnDay: ours,
    byReference,
    nearStartBefore: NEAR_START,
  };
}
const types = (r: ReturnType<typeof reconcile>) =>
  r.mismatches.map((m) => m.type);

describe('reconcile: match by bank reference, report what differs, decide nothing', () => {
  it('an empty day on both sides has nothing to report', () => {
    expect(reconcile(day([], []))).toEqual({ matched: 0, mismatches: [] });
  });

  it('every payment present on both sides for the same amount is matched', () => {
    const r = reconcile(
      day(
        [settled('111', 1_000_000n), settled('222', 2_500_000n)],
        [credited('111', 1_000_000n), credited('222', 2_500_000n)],
      ),
    );
    expect(r).toEqual({ matched: 2, mismatches: [] });
  });

  it('matches by reference alone: the padding, the order and the row numbers do not matter', () => {
    const r = reconcile(
      day(
        [
          settled('2222', 5n, { referenceRaw: ' 2222 ', rowNumber: '9' }),
          settled('1111', 7n, { referenceRaw: '0001111' }),
        ],
        [credited('1111', 7n), credited('2222', 5n)],
      ),
    );
    expect(r.matched).toBe(2);
  });

  describe('seeded mismatches are each reported with the right type', () => {
    const input = day(
      [
        settled('100', 1_000_000n),
        settled('200', 2_000_000n),
        settled('300', 3_000_000n),
        settled('400', 4_000_000n),
        settled('400', 4_000_000n),
        settled('500', 500_000n),
        settled('600', 600_000n, { jalaliDate: '1405/08/14' }),
      ],
      [
        credited('100', 1_000_000n),
        credited('200', 2_100_000n),
        credited('400', 4_000_000n),
        credited('700', 700_000n),
      ],
      [],
      [unreadable({ reason: 'BAD_REFERENCE' })],
    );
    const result = reconcile(input);
    const of = (type: string) =>
      result.mismatches.filter((m) => m.type === type);

    it('counts the two payments that are right: 100, and 400 whose row is repeated', () => {
      expect(result.matched).toBe(2);
    });

    it('MISSING_IN_LEDGER: the PSP settled 300 and 500, we credited neither', () => {
      expect(of('MISSING_IN_LEDGER').map((m) => m.reference)).toEqual([
        '300',
        '500',
      ]);
      expect(of('MISSING_IN_LEDGER')[0]).toMatchObject({
        depositId: null,
        ourAmountRial: null,
        theirAmountRial: 3_000_000n,
        details: { deposit: null },
      });
    });

    it('AMOUNT_MISMATCH: both have 200, for 2,000,000 and 2,100,000 rial', () => {
      expect(of('AMOUNT_MISMATCH')).toMatchObject([
        {
          reference: '200',
          depositId: 'dep-200',
          ourAmountRial: 2_100_000n,
          theirAmountRial: 2_000_000n,
        },
      ]);
    });

    it('DUPLICATE_IN_SETTLEMENT: 400 is on two rows', () => {
      expect(of('DUPLICATE_IN_SETTLEMENT')).toMatchObject([
        {
          reference: '400',
          depositId: 'dep-400',
          theirAmountRial: 4_000_000n,
          details: { count: 2, amountsDiffer: false },
        },
      ]);
    });

    it('MISSING_IN_SETTLEMENT: we credited 700 and the file does not list it', () => {
      expect(of('MISSING_IN_SETTLEMENT')).toMatchObject([
        {
          reference: '700',
          depositId: 'dep-700',
          ourAmountRial: 700_000n,
          theirAmountRial: null,
        },
      ]);
    });

    it('UNREADABLE_ROW: the row that could not be read, and the one dated another day', () => {
      const rows = of('UNREADABLE_ROW');
      expect(rows).toHaveLength(2);
      expect(rows[0].details).toMatchObject({ reason: 'BAD_REFERENCE' });
      expect(rows[1]).toMatchObject({
        reference: '600',
        details: {
          reason: 'DATE_MISMATCH',
          expected: DAY,
          found: '1405/08/14',
        },
      });
    });

    it('reports nothing else: unreadable rows first, then the file in its own order, then what we hold that it lacks', () => {
      expect(types(result)).toEqual([
        'UNREADABLE_ROW',
        'UNREADABLE_ROW',
        'AMOUNT_MISMATCH',
        'MISSING_IN_LEDGER',
        'DUPLICATE_IN_SETTLEMENT',
        'MISSING_IN_LEDGER',
        'MISSING_IN_SETTLEMENT',
      ]);
      expect(reconcile(input)).toEqual(result);
    });
  });

  describe('MISSING_IN_LEDGER says what we do have', () => {
    it('a deposit that exists but is not credited: the PSP verified a payment we have not credited', () => {
      const pending = credited('300', 3_000_000n, {
        status: 'PENDING',
        creditedRial: null,
        completedAt: null,
      });
      const r = reconcile(day([settled('300', 3_000_000n)], [], [pending]));
      expect(r.mismatches).toMatchObject([
        {
          type: 'MISSING_IN_LEDGER',
          reference: '300',
          depositId: 'dep-300',
          details: { deposit: { id: 'dep-300', status: 'PENDING' } },
        },
      ]);
    });
  });

  describe('a payment is looked up by reference, not by the day it was credited', () => {
    it('credited on another day: matched, not missing from the ledger', () => {
      const yesterday = credited('300', 3_000_000n, {
        completedAt: new Date('2026-11-05T20:00:00Z'),
      });
      const r = reconcile(day([settled('300', 3_000_000n)], [], [yesterday]));
      expect(r).toEqual({ matched: 1, mismatches: [] });
    });

    it('credited on another day for another amount: still an AMOUNT_MISMATCH', () => {
      const other = credited('300', 2_900_000n, {
        completedAt: new Date('2026-11-05T20:00:00Z'),
      });
      const r = reconcile(day([settled('300', 3_000_000n)], [], [other]));
      expect(types(r)).toEqual(['AMOUNT_MISMATCH']);
    });
  });

  describe('MISSING_IN_SETTLEMENT near the start of the day', () => {
    it('a credit within minutes of the day start may be in the previous file, and is marked', () => {
      const early = credited('300', 3_000_000n, {
        completedAt: new Date(START.getTime() + 60_000),
      });
      const late = credited('301', 1n, {
        completedAt: new Date(START.getTime() + 6 * 60_000),
      });
      const r = reconcile(day([], [early, late]));
      expect(
        r.mismatches.map((m) => [m.reference, m.details.nearDayStart]),
      ).toEqual([
        ['300', true],
        ['301', false],
      ]);
    });

    it('is reported in reference order', () => {
      const r = reconcile(
        day([], [credited('9', 1n), credited('10', 2n), credited('5', 3n)]),
      );
      expect(r.mismatches.map((m) => m.reference)).toEqual(['10', '5', '9']);
    });
  });

  describe('duplicates', () => {
    it('rows that repeat with different amounts are flagged, and the first row is the one compared', () => {
      const r = reconcile(
        day(
          [settled('400', 4_000_000n), settled('400', 4_100_000n)],
          [credited('400', 4_000_000n)],
        ),
      );
      expect(r.matched).toBe(1);
      expect(r.mismatches).toHaveLength(1);
      expect(r.mismatches[0].details).toMatchObject({
        count: 2,
        amountsDiffer: true,
        amountsRial: ['4000000', '4100000'],
      });
    });

    it('a duplicate of a payment we never credited is reported twice over: duplicate and missing', () => {
      const r = reconcile(
        day([settled('400', 1n), settled('400', 1n), settled('400', 1n)], []),
      );
      expect(types(r)).toEqual([
        'DUPLICATE_IN_SETTLEMENT',
        'MISSING_IN_LEDGER',
      ]);
      expect(r.mismatches[0].details.count).toBe(3);
    });
  });

  it('every row is accounted for: matched, or in a mismatch', () => {
    const rows = [
      settled('1', 10n),
      settled('2', 20n),
      settled('3', 30n),
      settled('3', 30n),
    ];
    const r = reconcile(
      day(rows, [credited('1', 10n), credited('2', 21n), credited('3', 30n)]),
    );
    const accounted = new Set<string | null>([
      ...r.mismatches.map((m) => m.reference),
    ]);
    expect(r.matched).toBe(2);
    expect([...accounted].sort()).toEqual(['2', '3']);
  });
});
