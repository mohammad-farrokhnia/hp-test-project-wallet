import type { Money } from '../../../common/money';
import type { PspStatus, VerifyOutcome } from '../../integrations/psp';
import type {
  DepositFailureReason,
  DepositReviewReason,
} from '../repositories/deposits.repository';
import {
  pollDelaySeconds,
  UNKNOWN_TOKEN_SECONDS,
  VERIFY_RETRY_SECONDS,
} from './deposit-schedule';

/** `verify` is set only when the status was PAID or VERIFIED. */
export type Observation =
  | { readonly kind: 'PSP_UNAVAILABLE' }
  | { readonly kind: 'UNKNOWN_TOKEN' }
  | {
      readonly kind: 'STATUS';
      readonly status: PspStatus;
      readonly verify: VerifyOutcome | null;
    };

/** The `PENDING` deposit as read under its row lock. */
export interface PendingDeposit {
  readonly requested: Money;
  readonly checkAttempts: number;
  readonly ageSeconds: number;
}

export interface SyncDecision {
  readonly rule: 'D6' | 'D8' | 'D9' | 'D10' | 'D11' | 'D12' | 'D16' | 'WAIT';
  readonly to?: 'SUCCEEDED' | 'FAILED';
  readonly failureReason?: DepositFailureReason;
  readonly credit?: { readonly amount: Money; readonly refId: string };
  readonly review?: DepositReviewReason;
  readonly pspStatus?: PspStatus;
  readonly paidSeen: boolean;
  readonly nextCheckSeconds: number | null;
}

/**
 * @function decideDepositSync
 * @description The deposit state machine for a sync of a `PENDING` deposit. Only the PSP's own status and verify decide:
 * - FAILED / REVERSED fail the deposit; INIT keeps it pending;
 * - PAID / VERIFIED credit only when verify answers `OK` (100) or `ALREADY_VERIFIED` (101), and only the amount verify returns;
 * - verify unavailable (503, PSP-09) or `-51` (PSP-08) keeps it pending and retries in seconds;
 * @param observation - what the lookup and verify returned
 * @param deposit - the deposit under its lock
 * @returns what to apply
 */
export function decideDepositSync(
  observation: Observation,
  deposit: PendingDeposit,
): SyncDecision {
  const poll = pollDelaySeconds(deposit.checkAttempts, deposit.ageSeconds);

  if (observation.kind === 'PSP_UNAVAILABLE') {
    return { rule: 'WAIT', paidSeen: false, nextCheckSeconds: poll };
  }
  if (observation.kind === 'UNKNOWN_TOKEN') {
    return {
      rule: 'D16',
      review: 'UNKNOWN_TOKEN',
      paidSeen: false,
      nextCheckSeconds: UNKNOWN_TOKEN_SECONDS,
    };
  }

  const { status, verify } = observation;
  switch (status) {
    case 'INIT':
      return {
        rule: 'D6',
        pspStatus: status,
        paidSeen: false,
        nextCheckSeconds: poll,
      };
    case 'FAILED':
      return {
        rule: 'D11',
        to: 'FAILED',
        failureReason: 'PSP_FAILED',
        pspStatus: status,
        paidSeen: false,
        nextCheckSeconds: null,
      };
    case 'REVERSED':
      return {
        rule: 'D12',
        to: 'FAILED',
        failureReason: 'PSP_REVERSED',
        review: 'UNVERIFIED_TOO_LONG',
        pspStatus: status,
        paidSeen: false,
        nextCheckSeconds: null,
      };
    case 'PAID':
    case 'VERIFIED':
      return afterPaid(status, verify, deposit);
  }
}

function afterPaid(
  status: PspStatus,
  verify: VerifyOutcome | null,
  deposit: PendingDeposit,
): SyncDecision {
  const retry = {
    pspStatus: status,
    paidSeen: true,
    nextCheckSeconds: VERIFY_RETRY_SECONDS,
  } as const;
  switch (verify?.kind) {
    case 'OK':
    case 'ALREADY_VERIFIED':
      return {
        rule: 'D8',
        to: 'SUCCEEDED',
        credit: { amount: verify.amount, refId: verify.refId },
        review: verify.amount.equals(deposit.requested)
          ? undefined
          : 'AMOUNT_DIFFERS',
        pspStatus: 'VERIFIED',
        paidSeen: true,
        nextCheckSeconds: null,
      };
    case 'NOT_PAID':
      return { rule: 'D10', ...retry };
    case 'NOT_FOUND':
      return {
        rule: 'D16',
        review: 'UNKNOWN_TOKEN',
        pspStatus: status,
        paidSeen: true,
        nextCheckSeconds: UNKNOWN_TOKEN_SECONDS,
      };
    case 'UNAVAILABLE':
    case undefined:
      return { rule: 'D9', ...retry };
  }
}
