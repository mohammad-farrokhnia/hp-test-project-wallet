import {
  isValidIban,
  isValidTrc20,
  normalizeIban,
} from '../../../common/validation';
import type { DestinationType } from './withdrawal-policy';

/**
 * @function parseDestination
 * @description Validates a destination for the currency's destination type and returns its stored form. Our own check matters: the payout service pays invalid addresses (PAY-06). Sheba: spaces, hyphens and lowercase are accepted, then normalised (`IR` + 24 digits, mod-97). TRC20: base58check with prefix 0x41, taken exactly as sent.
 * @param type - from the currency's policy
 * @param raw - what the client sent
 * @returns the normalised destination, or `null` if it is not valid for `type`
 */
export function parseDestination(
  type: DestinationType,
  raw: string,
): string | null {
  if (type === 'IBAN') {
    return isValidIban(raw) ? normalizeIban(raw) : null;
  }
  const address = raw.trim();
  return isValidTrc20(address) ? address : null;
}

/**
 * @function maskDestination
 * @description What responses and logs show: the first and last 4 characters (`IR06******************0001`).
 * Full IBANs never leave the service after the request.
 */
export function maskDestination(destination: string): string {
  if (destination.length <= 8) return '*'.repeat(destination.length);
  return `${destination.slice(0, 4)}${'*'.repeat(destination.length - 8)}${destination.slice(-4)}`;
}
