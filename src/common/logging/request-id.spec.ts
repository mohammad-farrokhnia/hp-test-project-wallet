import { IncomingMessage, ServerResponse } from 'node:http';
import { resolveRequestId } from './request-id';

function fakeCall(headerValue?: string | string[]) {
  const headers: Record<string, string | string[]> = {};
  if (headerValue !== undefined) headers['x-request-id'] = headerValue;
  const req = { headers } as unknown as IncomingMessage & { id?: unknown };
  const set: Record<string, string> = {};
  const res = {
    headersSent: false,
    setHeader: (k: string, v: string) => {
      set[k] = v;
    },
  } as unknown as ServerResponse;
  return { req, res, set };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('generates a UUID when none is sent and echoes it', () => {
    const { req, res, set } = fakeCall();
    const id = resolveRequestId(req, res);
    expect(id).toMatch(UUID);
    expect(set['X-Request-Id']).toBe(id);
    expect(req.id).toBe(id);
  });

  it.each([
    'abc-123',
    'a.b_c-d',
    '0'.repeat(64),
    '550e8400-e29b-41d4-a716-446655440000',
  ])('reuses the well-formed incoming id %j', (value) => {
    const { req, res, set } = fakeCall(value);
    expect(resolveRequestId(req, res)).toBe(value);
    expect(set['X-Request-Id']).toBe(value);
  });

  it.each([
    ['too long', '0'.repeat(65)],
    ['empty', ''],
    ['with a space', 'a b'],
    ['with a newline (header injection)', 'abc\nSet-Cookie: x=1'],
    ['with a slash', 'a/b'],
    ['non-ASCII', 'ñandú'],
    ['repeated header', ['a', 'b']],
  ])('replaces an unacceptable id: %s', (_why, value) => {
    const { req, res } = fakeCall(value);
    expect(resolveRequestId(req, res)).toMatch(UUID);
  });

  it('returns the same id when called twice for one request', () => {
    const { req, res } = fakeCall();
    expect(resolveRequestId(req, res)).toBe(resolveRequestId(req, res));
  });
});
