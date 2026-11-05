const MINUTE_S = 60;

/** Seconds to the next check after a verify that was not applied or answered `-51`. */
export const VERIFY_RETRY_SECONDS = 5;

/** Seconds to the next check after the PSP did not know the token. */
export const UNKNOWN_TOKEN_SECONDS = 5 * MINUTE_S;

const FIRST_CHECKS_SECONDS = [15, 15, 30] as const;
const MINUTE_POLLING_UNTIL_AGE_S = 30 * MINUTE_S;

/**
 * @function pollDelaySeconds
 * @description The poll schedule for a deposit waiting for its payer: 15 s, 15 s, 30 s,
 * then every minute until 30 minutes after creation, then every 5 minutes.
 * @param checkAttempts - checks already made
 * @param ageSeconds - seconds since the deposit was created
 * @returns seconds until the next check
 */
export function pollDelaySeconds(
  checkAttempts: number,
  ageSeconds: number,
): number {
  if (checkAttempts < FIRST_CHECKS_SECONDS.length) {
    return FIRST_CHECKS_SECONDS[checkAttempts];
  }
  return ageSeconds < MINUTE_POLLING_UNTIL_AGE_S ? MINUTE_S : 5 * MINUTE_S;
}
