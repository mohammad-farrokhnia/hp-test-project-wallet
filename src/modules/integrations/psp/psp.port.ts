import type { Money } from '../../../common/money';

export const PSP_CLIENT = Symbol('PSP_CLIENT');

/** The PSP's payment vocabulary: `INIT → PAID → VERIFIED`, `INIT → FAILED`, `PAID → REVERSED`. */
export type PspStatus = 'INIT' | 'PAID' | 'VERIFIED' | 'FAILED' | 'REVERSED';

export type CreatePaymentOutcome =
  | {
      readonly kind: 'CREATED';
      readonly token: string;
      readonly paymentUrl: string;
    }
  | {
      readonly kind: 'REJECTED';
      readonly code: number | null;
      readonly message: string | null;
    }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

export type PaymentLookup =
  | {
      readonly kind: 'FOUND';
      readonly status: PspStatus;
      readonly amount: Money;
      readonly refId: string | null;
    }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

export type VerifyOutcome =
  | {
      readonly kind: 'OK';
      readonly amount: Money;
      readonly refId: string;
    }
  | {
      readonly kind: 'ALREADY_VERIFIED';
      readonly amount: Money;
      readonly refId: string;
    }
  | { readonly kind: 'NOT_PAID' }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

/**
 * The payment gateway as the deposit module sees it: outcomes, never HTTP codes.
 * The adapter is the only code that knows URLs, status codes and quirks.
 */
export interface PspClient {
  /**
   * `CREATED` (201) · `REJECTED` (4xx: nothing was created) · `UNAVAILABLE` (5xx, timeout, reset, unreadable).
   * Not idempotent at the PSP (PSP-03): every call that succeeds makes a new token.
   * @param amount - rial
   * @param orderId - our deposit id, for correlation only
   * @param callbackUrl - where the PSP posts its (untrusted) callback
   */
  createPayment(
    amount: Money,
    orderId: string,
    callbackUrl: string,
  ): Promise<CreatePaymentOutcome>;
  /** `FOUND` (200) · `NOT_FOUND` (404 / -9) · `UNAVAILABLE`. */
  getPayment(token: string): Promise<PaymentLookup>;
  /**
   * `OK` (100) and `ALREADY_VERIFIED` (101) both mean credit the returned amount ·
   * `NOT_PAID` (-51, also returned while the payment is still INIT: check the status, never fail on it) ·
   * `NOT_FOUND` (-9) · `UNAVAILABLE` (503 / -1, timeout: the 503 was not applied, retry).
   */
  verify(token: string): Promise<VerifyOutcome>;
}
