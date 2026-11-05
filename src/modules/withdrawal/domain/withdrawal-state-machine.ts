import type { TransferStatus } from '../../integrations/payout';
import type { WithdrawalStatus } from '../repositories/withdrawals.repository';

/** What a sync's GET found. */
export type Lookup =
  | {
      readonly kind: 'FOUND';
      readonly status: TransferStatus;
      readonly reason: string | null;
      readonly trackingId: string | null;
    }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'UNAVAILABLE' };

/** The withdrawal as read under its row lock. */
export interface SyncState {
  readonly status: WithdrawalStatus;
  readonly returned: boolean;
  readonly attemptInFlight: boolean;
  readonly lastAttemptRejected: boolean;
  readonly uncertainTooLong: boolean;
}

export type SyncJournal = 'SETTLE' | 'RELEASE' | 'RETURN' | 'LATE_SUCCESS';

export interface SyncDecision {
  readonly rule: string;
  readonly to?: WithdrawalStatus;
  readonly failureReason?: 'PROVIDER_REJECTED' | 'PROVIDER_FAILED';
  /** Journals to book, in order. */
  readonly journals: readonly SyncJournal[];
  readonly releaseUsage: boolean;
  readonly returnReason?: string | null;
  readonly resubmit: boolean;
  readonly review?: 'UNKNOWN_AFTER_SUCCESS' | 'LATE_SUCCESS';
  readonly lateSuccess?: boolean;
  readonly nextCheckSeconds: number | null;
}

/** Next-check times from state-machines.md. */
export const SCHEDULE = {
  processing: 30,
  resubmitted: 30,
  unavailable: 30,
  returnWatch: 300,
} as const;

const OPEN = new Set<WithdrawalStatus>(['PENDING', 'SUBMITTING', 'PROCESSING']);

const none = { journals: [], releaseUsage: false, resubmit: false } as const;

/**
 * @function decideSync
 * @description The withdrawal state machine for a sync, forward only.
 * Statuses rank ACCEPTED, PROCESSING < SUCCEEDED, FAILED < RETURNED; anything at or below where the withdrawal already is changes nothing.
 * @param s - the withdrawal under its lock
 * @param found - what the GET returned
 * @returns what to do
 */
export function decideSync(s: SyncState, found: Lookup): SyncDecision {
  if (s.status === 'FAILED') return afterFailure(found);
  if (s.status === 'SUCCEEDED') return afterSuccess(s, found);
  if (!OPEN.has(s.status))
    return { rule: 'FINAL', ...none, nextCheckSeconds: null };

  if (found.kind === 'UNAVAILABLE') {
    return {
      rule: 'UNAVAILABLE',
      ...none,
      nextCheckSeconds: SCHEDULE.unavailable,
    };
  }
  if (found.kind === 'NOT_FOUND') return notFound(s);

  switch (found.status) {
    case 'ACCEPTED':
    case 'PROCESSING':
      return {
        rule: 'W7',
        to: 'PROCESSING',
        ...none,
        nextCheckSeconds: SCHEDULE.processing,
      };
    case 'SUCCEEDED':
      return {
        rule: 'W8',
        to: 'SUCCEEDED',
        ...none,
        journals: ['SETTLE'],
        nextCheckSeconds: SCHEDULE.returnWatch,
      };
    case 'FAILED':
      return {
        rule: 'W9',
        to: 'FAILED',
        failureReason: 'PROVIDER_FAILED',
        ...none,
        journals: ['RELEASE'],
        releaseUsage: true,
        nextCheckSeconds: null,
      };
    case 'RETURNED':
      return {
        rule: 'W11',
        to: 'SUCCEEDED',
        ...none,
        journals: ['SETTLE', 'RETURN'],
        returnReason: found.reason,
        nextCheckSeconds: null,
      };
  }
}

/**
 * GET 404 for a withdrawal that is not final. For PROCESSING the provider had accepted it, and in hostile mode a transfer whose
 * create timed out answers 404 for a while after a replay proved it exists: so a young 404 only checks again in 30 s,
 * and only one that outlasts `REVIEW_AFTER_MINUTES` is flagged. Money never moves on a 404 here.
 */
function notFound(s: SyncState): SyncDecision {
  if (s.status === 'PROCESSING' && !s.uncertainTooLong) {
    return {
      rule: 'UNKNOWN_QUIET',
      ...none,
      nextCheckSeconds: SCHEDULE.unavailable,
    };
  }
  if (s.status === 'PROCESSING') {
    return {
      rule: 'UNKNOWN_AFTER_ACCEPT',
      ...none,
      review: 'UNKNOWN_AFTER_SUCCESS',
      nextCheckSeconds: SCHEDULE.returnWatch,
    };
  }
  if (s.attemptInFlight) {
    return {
      rule: 'IN_FLIGHT',
      ...none,
      nextCheckSeconds: SCHEDULE.resubmitted,
    };
  }
  if (s.lastAttemptRejected) {
    return {
      rule: 'W6',
      to: 'FAILED',
      failureReason: 'PROVIDER_REJECTED',
      ...none,
      journals: ['RELEASE'],
      releaseUsage: true,
      nextCheckSeconds: null,
    };
  }
  return {
    rule: 'W5',
    ...none,
    resubmit: true,
    nextCheckSeconds: SCHEDULE.resubmitted,
  };
}

/**
 * The provider paid a withdrawal we had failed and released. Only a
 * signed webhook makes the sync pull a FAILED one. The money left, so claw it back: AVAILABLE
 * first, the rest as DEBT (`clawbackLines`). The status becomes SUCCEEDED, flagged for a person.
 * The daily limit is not reserved again. RETURNED means it was paid and came back: claw back,
 * then credit the return, in one transaction.
 */
function afterFailure(found: Lookup): SyncDecision {
  if (found.kind !== 'FOUND')
    return { rule: 'FINAL', ...none, nextCheckSeconds: null };
  const lateSuccess = {
    to: 'SUCCEEDED',
    lateSuccess: true,
    review: 'LATE_SUCCESS',
    releaseUsage: false,
    resubmit: false,
  } as const;
  if (found.status === 'SUCCEEDED') {
    return {
      rule: 'W12',
      ...lateSuccess,
      journals: ['LATE_SUCCESS'],
      nextCheckSeconds: SCHEDULE.returnWatch,
    };
  }
  if (found.status === 'RETURNED') {
    return {
      rule: 'W12',
      ...lateSuccess,
      journals: ['LATE_SUCCESS', 'RETURN'],
      returnReason: found.reason,
      nextCheckSeconds: null,
    };
  }
  return { rule: 'FINAL', ...none, nextCheckSeconds: null };
}

/**
 * A SUCCEEDED withdrawal is final, but watched for a bank return. A 404 here is the same provider lag as for PROCESSING
 * (a transfer the provider already reported SUCCEEDED answered 404 minutes later): quiet inside `REVIEW_AFTER_MINUTES`, flagged after.
 */
function afterSuccess(s: SyncState, found: Lookup): SyncDecision {
  if (s.returned) return { rule: 'FINAL', ...none, nextCheckSeconds: null };
  if (found.kind === 'FOUND' && found.status === 'RETURNED') {
    return {
      rule: 'W10',
      ...none,
      journals: ['RETURN'],
      returnReason: found.reason,
      nextCheckSeconds: null,
    };
  }
  if (found.kind === 'NOT_FOUND' && !s.uncertainTooLong) {
    return {
      rule: 'UNKNOWN_QUIET',
      ...none,
      nextCheckSeconds: SCHEDULE.unavailable,
    };
  }
  if (found.kind === 'NOT_FOUND') {
    return {
      rule: 'UNKNOWN_AFTER_SUCCESS',
      ...none,
      review: 'UNKNOWN_AFTER_SUCCESS',
      nextCheckSeconds: SCHEDULE.returnWatch,
    };
  }
  return { rule: 'IGNORED', ...none, nextCheckSeconds: SCHEDULE.returnWatch };
}
