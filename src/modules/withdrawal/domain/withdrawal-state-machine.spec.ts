import type { TransferStatus } from '../../integrations/payout';
import type { WithdrawalStatus } from '../repositories/withdrawals.repository';
import { decideSync, Lookup, SyncState } from './withdrawal-state-machine';

const state = (
  status: WithdrawalStatus,
  over: Partial<SyncState> = {},
): SyncState => ({
  status,
  returned: false,
  attemptInFlight: false,
  lastAttemptRejected: false,
  ...over,
});
const found = (
  status: TransferStatus,
  reason: string | null = null,
): Lookup => ({
  kind: 'FOUND',
  status,
  reason,
  trackingId: 'TRK1',
});
const NOT_FOUND: Lookup = { kind: 'NOT_FOUND' };
const UNAVAILABLE: Lookup = { kind: 'UNAVAILABLE' };

describe('decideSync: the withdrawal state machine (state-machines.md)', () => {
  describe.each(['PENDING', 'SUBMITTING', 'PROCESSING'] as const)(
    'from %s',
    (from) => {
      it.each([
        ['ACCEPTED', 'W7', 'PROCESSING', [], 30],
        ['PROCESSING', 'W7', 'PROCESSING', [], 30],
        ['SUCCEEDED', 'W8', 'SUCCEEDED', ['SETTLE'], 300],
        ['FAILED', 'W9', 'FAILED', ['RELEASE'], null],
        ['RETURNED', 'W11', 'SUCCEEDED', ['SETTLE', 'RETURN'], null],
      ] as const)('GET %s → %s', (status, rule, to, journals, next) => {
        const d = decideSync(
          state(from),
          found(status, status === 'RETURNED' ? 'ACCOUNT_CLOSED' : null),
        );
        expect(d).toMatchObject({ rule, to, journals, nextCheckSeconds: next });
      });

      it('GET FAILED fails it as PROVIDER_FAILED and releases the daily limit (W9)', () => {
        expect(
          decideSync(state(from), found('FAILED', 'INVALID_IBAN')),
        ).toMatchObject({
          failureReason: 'PROVIDER_FAILED',
          releaseUsage: true,
        });
      });

      it('GET RETURNED records the return reason and keeps the daily limit (W11)', () => {
        expect(
          decideSync(state(from), found('RETURNED', 'ACCOUNT_CLOSED')),
        ).toMatchObject({
          returnReason: 'ACCOUNT_CLOSED',
          releaseUsage: false,
        });
      });

      it('provider unreachable: nothing changes, look again soon', () => {
        expect(decideSync(state(from), UNAVAILABLE)).toEqual({
          rule: 'UNAVAILABLE',
          journals: [],
          releaseUsage: false,
          resubmit: false,
          nextCheckSeconds: 30,
        });
      });
    },
  );

  describe('GET 404', () => {
    it.each(['PENDING', 'SUBMITTING'] as const)(
      '%s, no attempt in flight → resubmit the same requestId (W5)',
      (s) => {
        expect(decideSync(state(s), NOT_FOUND)).toMatchObject({
          rule: 'W5',
          resubmit: true,
          journals: [],
        });
      },
    );

    it('SUBMITTING with an attempt in flight → wait for it, no resubmit', () => {
      expect(
        decideSync(state('SUBMITTING', { attemptInFlight: true }), NOT_FOUND),
      ).toMatchObject({
        rule: 'IN_FLIGHT',
        resubmit: false,
      });
    });

    it('SUBMITTING after a 400 → FAILED PROVIDER_REJECTED, released (W6)', () => {
      expect(
        decideSync(
          state('SUBMITTING', { lastAttemptRejected: true }),
          NOT_FOUND,
        ),
      ).toMatchObject({
        rule: 'W6',
        to: 'FAILED',
        failureReason: 'PROVIDER_REJECTED',
        journals: ['RELEASE'],
        releaseUsage: true,
      });
    });

    it('PROCESSING (the provider had accepted it) → review, no money moves', () => {
      expect(decideSync(state('PROCESSING'), NOT_FOUND)).toMatchObject({
        review: 'UNKNOWN_AFTER_SUCCESS',
        journals: [],
      });
    });
  });

  describe('SUCCEEDED is final but watched for returns', () => {
    it('GET RETURNED → return journal, status unchanged (W10)', () => {
      expect(
        decideSync(state('SUCCEEDED'), found('RETURNED', 'ACCOUNT_CLOSED')),
      ).toMatchObject({
        rule: 'W10',
        journals: ['RETURN'],
        returnReason: 'ACCOUNT_CLOSED',
        releaseUsage: false,
        nextCheckSeconds: null,
      });
    });

    it.each(['ACCEPTED', 'PROCESSING', 'SUCCEEDED', 'FAILED'] as const)(
      'GET %s (ranked at or below SUCCEEDED, PAY-11) → ignored, keep watching',
      (status) => {
        expect(decideSync(state('SUCCEEDED'), found(status))).toMatchObject({
          rule: 'IGNORED',
          journals: [],
          nextCheckSeconds: 300,
        });
      },
    );

    it('already returned → final, a second RETURNED books nothing', () => {
      expect(
        decideSync(state('SUCCEEDED', { returned: true }), found('RETURNED')),
      ).toMatchObject({
        rule: 'FINAL',
        journals: [],
        nextCheckSeconds: null,
      });
    });
  });

  describe('FAILED, then the provider says it paid after all (W12, Ambiguity #1)', () => {
    it('GET SUCCEEDED → SUCCEEDED, claw back, flagged LATE_SUCCESS, limit not re-reserved', () => {
      expect(decideSync(state('FAILED'), found('SUCCEEDED'))).toMatchObject({
        rule: 'W12',
        to: 'SUCCEEDED',
        journals: ['LATE_SUCCESS'],
        lateSuccess: true,
        review: 'LATE_SUCCESS',
        releaseUsage: false,
        nextCheckSeconds: 300,
      });
    });

    it('GET RETURNED → claw back, then the return, together', () => {
      expect(
        decideSync(state('FAILED'), found('RETURNED', 'ACCOUNT_CLOSED')),
      ).toMatchObject({
        rule: 'W12',
        to: 'SUCCEEDED',
        journals: ['LATE_SUCCESS', 'RETURN'],
        returnReason: 'ACCOUNT_CLOSED',
        nextCheckSeconds: null,
      });
    });
  });

  it.each(['ACCEPTED', 'PROCESSING', 'FAILED'] as const)(
    'FAILED is final: GET %s changes nothing',
    (status) => {
      expect(decideSync(state('FAILED'), found(status))).toMatchObject({
        rule: 'FINAL',
        journals: [],
      });
    },
  );

  it.each([
    ['SUBMITTING', NOT_FOUND],
    ['PROCESSING', NOT_FOUND],
    ['SUCCEEDED', found('RETURNED')],
    ['SUCCEEDED', found('PROCESSING')],
  ] as const)('%s + %j leaves the status as it is', (from, lookup) => {
    expect(decideSync(state(from), lookup).to).toBeUndefined();
  });

  it('never books more than one terminal journal (SETTLE or RELEASE) in a single decision', () => {
    const statuses: WithdrawalStatus[] = [
      'PENDING',
      'SUBMITTING',
      'PROCESSING',
      'SUCCEEDED',
      'FAILED',
    ];
    const lookups: Lookup[] = [
      ...(
        ['ACCEPTED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'RETURNED'] as const
      ).map((s) => found(s)),
      NOT_FOUND,
      UNAVAILABLE,
    ];
    for (const s of statuses) {
      for (const l of lookups) {
        const terminal = decideSync(state(s), l).journals.filter(
          (j) => j !== 'RETURN',
        );
        expect(terminal.length).toBeLessThanOrEqual(1);
      }
    }
  });
});
