import {
  decodeCursor,
  DEFAULT_LIMIT,
  encodeCursor,
  parseLimit,
} from './history-query';

describe('cursor', () => {
  it.each([1n, 42n, 9_223_372_036_854_775_807n])(
    'round-trips posting id %s',
    (id) => {
      expect(decodeCursor(encodeCursor(id))).toBe(id);
    },
  );

  it('is opaque base64url, not the bare id', () => {
    expect(encodeCursor(42n)).toBe('NDI');
  });

  it.each([
    ['not base64url', 'NDI='],
    ['garbage', '!!!'],
    ['an empty string', ''],
    ['not a number inside', Buffer.from('abc').toString('base64url')],
    ['zero', Buffer.from('0').toString('base64url')],
    ['a leading zero', Buffer.from('042').toString('base64url')],
    ['a negative id', Buffer.from('-5').toString('base64url')],
    ['beyond BIGINT', Buffer.from('9223372036854775808').toString('base64url')],
    ['a non-canonical encoding of a valid id', 'NDJ'],
  ])('refuses %s with INVALID_CURSOR', (_case, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(
      expect.objectContaining({ code: 'INVALID_CURSOR', status: 400 }) as Error,
    );
  });
});

describe('parseLimit', () => {
  it('defaults to 20', () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
  });

  it.each([
    ['1', 1],
    ['100', 100],
    ['020', 20],
  ])('accepts %s', (raw, n) => {
    expect(parseLimit(raw)).toBe(n);
  });

  it.each(['0', '101', '1000', '-1', '1.5', 'abc', '', ' 5'])(
    'refuses %j with VALIDATION_ERROR',
    (raw) => {
      expect(() => parseLimit(raw)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }) as Error,
      );
    },
  );
});
