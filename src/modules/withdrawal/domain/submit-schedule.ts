/** When to look at a withdrawal again after a submit. */

/** the provider accepted it; check its progress soon. */
export const AFTER_ACCEPTED_SECONDS = 10;

/** a replay with other fields; a person reviews it, the money stays frozen. */
export const AFTER_MISMATCH_SECONDS = 300;

/** 503, timeout or reset: 2 s, 5 s, 15 s, then every 60 s. Never FAILED by silence. */
const AMBIGUOUS_BACKOFF_SECONDS = [2, 5, 15];
const AMBIGUOUS_STEADY_SECONDS = 60;

/**
 * @function afterAmbiguousSeconds
 * @param attemptNo - the attempt that was ambiguous, from 1
 * @returns seconds until the next check
 */
export function afterAmbiguousSeconds(attemptNo: number): number {
  return AMBIGUOUS_BACKOFF_SECONDS[attemptNo - 1] ?? AMBIGUOUS_STEADY_SECONDS;
}
