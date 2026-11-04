/** 1–64 characters from `[A-Za-z0-9_-]`. */
export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const USER_ID_MESSAGE =
  'userId must be 1-64 characters from A-Z, a-z, 0-9, _ and -';

export function isValidUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID_PATTERN.test(value);
}
