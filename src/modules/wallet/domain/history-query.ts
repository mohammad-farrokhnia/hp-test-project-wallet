import { AppError } from '../../../common/errors';
import { INT64_MAX } from '../../../common/money';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

const POSITIVE_ID = /^[1-9][0-9]{0,18}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * @function encodeCursor
 * @description The client-facing cursor: base64url of the last posting id. Opaque, so the paging scheme can change without breaking clients.
 */
export function encodeCursor(postingId: bigint): string {
  return Buffer.from(postingId.toString()).toString('base64url');
}

/**
 * @function decodeCursor
 * @description Reverses `encodeCursor`. Only the exact text `encodeCursor` produced is accepted, so a tampered cursor can't name some other position.
 * @param cursor - from the previous page's `nextCursor`
 * @returns the posting id to page before
 * @throws {AppError} `INVALID_CURSOR` (400)
 */
export function decodeCursor(cursor: string): bigint {
  if (!BASE64URL.test(cursor)) throw new AppError('INVALID_CURSOR');
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!POSITIVE_ID.test(text)) throw new AppError('INVALID_CURSOR');
  const id = BigInt(text);
  if (id > INT64_MAX || encodeCursor(id) !== cursor) {
    throw new AppError('INVALID_CURSOR');
  }
  return id;
}

/**
 * @function parseLimit
 * @param raw - the `limit` query parameter, if any
 * @returns 1–100; `DEFAULT_LIMIT` when absent
 * @throws {AppError} `VALIDATION_ERROR` (400)
 */
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = /^[0-9]{1,3}$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
  if (!(n >= 1 && n <= MAX_LIMIT)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `limit must be a whole number from 1 to ${MAX_LIMIT}`,
    );
  }
  return n;
}
