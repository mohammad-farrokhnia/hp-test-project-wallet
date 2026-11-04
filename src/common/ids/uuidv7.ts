import { randomBytes } from 'node:crypto';

/**
 * @function uuidv7
 * @description RFC 9562 UUIDv7: 48-bit Unix milliseconds, then 74 random bits.
 * @param now - milliseconds since the epoch; defaults to the current time
 * @returns the id in canonical lowercase form
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  // 48-bit timestamp, big-endian; exact, since it is far below 2^53.
  for (let i = 0; i < 6; i++) {
    bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) % 256;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
