import { canonicalJson, fingerprint } from './fingerprint';

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[1,2]},"b":1}',
    );
  });

  it('keeps array order: it is part of the meaning', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('drops undefined object values, like JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('escapes keys and strings as JSON does', () => {
    expect(canonicalJson({ 'a"b': 'line\nbreak' })).toBe(
      '{"a\\"b":"line\\nbreak"}',
    );
  });
});

describe('fingerprint', () => {
  const body = { amount: '100000', currency: 'IRT', userId: 'alice' };

  it('is the same for the same body in any key order', () => {
    expect(fingerprint('POST /withdrawals', body)).toBe(
      fingerprint('POST /withdrawals', {
        userId: 'alice',
        currency: 'IRT',
        amount: '100000',
      }),
    );
  });

  it('differs when any value differs', () => {
    expect(fingerprint('POST /withdrawals', body)).not.toBe(
      fingerprint('POST /withdrawals', { ...body, amount: '100001' }),
    );
  });

  it('differs for the same body on another route: keys are global', () => {
    expect(fingerprint('POST /withdrawals', body)).not.toBe(
      fingerprint('POST /deposits', body),
    );
  });

  it('is a sha256 hex digest', () => {
    expect(fingerprint('POST /deposits', {})).toMatch(/^[0-9a-f]{64}$/);
  });
});
