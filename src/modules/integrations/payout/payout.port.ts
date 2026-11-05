import type { Money } from '../../../common/money';

export const PAYOUT_CLIENT = Symbol('PAYOUT_CLIENT');

/** What we ask the payout service to pay. `requestId` is the withdrawal id, never regenerated. */
export interface PayoutRequest {
  readonly requestId: string;
  readonly destinationType: 'IBAN' | 'TRC20';
  readonly destination: string;
  readonly amount: Money;
}

export type TransferStatus =
  'ACCEPTED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'RETURNED';

/** The payout service's view of a transfer. */
export interface TransferSnapshot {
  readonly requestId: string;
  readonly trackingId: string | null;
  readonly status: TransferStatus;
  /** e.g. `INVALID_IBAN`, `ACCOUNT_CLOSED` */
  readonly reason: string | null;
  readonly amount: Money;
  readonly destination: string;
}

/** What the call looked like on the wire, for `payout_attempts`. */
export interface Exchange {
  /** The body we sent. */
  readonly requestBody: Record<string, unknown>;
  readonly httpStatus: number | null;
  readonly responseBody: unknown;
  readonly error: string | null;
}

/** A field of a replayed transfer that differs from what we sent. */
export type ReplayField = 'requestId' | 'amount' | 'currency' | 'destination';

export type SubmitOutcome = Exchange &
  (
    | { readonly kind: 'ACCEPTED'; readonly snapshot: TransferSnapshot }
    | {
        readonly kind: 'REPLAYED';
        readonly snapshot: TransferSnapshot;
        readonly mismatches: readonly ReplayField[];
      }
    | { readonly kind: 'REJECTED'; readonly error: string }
    | { readonly kind: 'AMBIGUOUS'; readonly reason: string }
  );

export type LookupOutcome =
  | { readonly kind: 'FOUND'; readonly snapshot: TransferSnapshot }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

/**
 * The payout service as the withdrawal module sees it: outcomes, never HTTP codes.
 * The adapter is the only code that knows URLs, status codes and quirks.
 */
export interface PayoutClient {
  /** Exactly the body `submit` sends, so the attempt can be recorded before the call. */
  requestBody(request: PayoutRequest): Record<string, unknown>;
  /**
   * `ACCEPTED` (202) · `REPLAYED` (200, compared with ours) · `REJECTED` (400/422) ·
   * `AMBIGUOUS` (503, timeout, reset, anything else: it may have been created).
   */
  submit(request: PayoutRequest): Promise<SubmitOutcome>;
  /** `FOUND` (200) · `NOT_FOUND` (404) · `UNAVAILABLE`. */
  getTransfer(requestId: string): Promise<LookupOutcome>;
}
