/** What a request with an Idempotency-Key asks for. */
export interface ClaimRequest {
  readonly key: string;
  readonly scope: string;
  readonly body: unknown;
}

/** A response kept so a repeat of the request gets exactly the same answer. */
export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

/** The record a request created, kept on the key. */
export interface ResourceRef {
  readonly type: string;
  readonly id: string;
}

/** `claim` result: do the work (`NEW`), or answer with the stored response (`REPLAY`). */
export type ClaimResult =
  | { readonly kind: 'NEW' }
  | { readonly kind: 'REPLAY'; readonly response: StoredResponse };

/** `claimWithLease` result: as `claim`, plus a live twin (`IN_PROGRESS`) or a dead earlier attempt to continue (`RESUME`). */
export type LeaseClaimResult =
  | ClaimResult
  | { readonly kind: 'IN_PROGRESS' }
  | { readonly kind: 'RESUME'; readonly resource: ResourceRef | null };
