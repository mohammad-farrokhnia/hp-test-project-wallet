import { Money } from '../../../common/money';
import {
  classifyCreate,
  classifyLookup,
  classifySettlement,
  classifyVerify,
} from './psp-classifier';

const answer = (status: number, body: unknown) => ({ status, body });

describe('classifyVerify (PSP-08, PSP-09)', () => {
  it.each([
    [
      '100 OK (evidence PSP-08)',
      answer(200, {
        code: 100,
        status: 'OK',
        amount: '1000000',
        refId: '2530490385',
      }),
      { kind: 'OK', amount: Money.rial(1_000_000n), refId: '2530490385' },
    ],
    [
      '101 ALREADY_VERIFIED, same refId (evidence PSP-08)',
      answer(200, {
        code: 101,
        status: 'ALREADY_VERIFIED',
        amount: '1000000',
        refId: '2530490385',
      }),
      {
        kind: 'ALREADY_VERIFIED',
        amount: Money.rial(1_000_000n),
        refId: '2530490385',
      },
    ],
    [
      '-51 with HTTP 200, also what an unpaid INIT payment answers (PSP-08)',
      answer(200, {
        code: -51,
        status: 'FAILED',
        message: 'payment not successful',
      }),
      { kind: 'NOT_PAID' },
    ],
    [
      '503 -1 (evidence PSP-09)',
      answer(503, { code: -1, message: 'service unavailable' }),
      { kind: 'UNAVAILABLE', reason: 'HTTP_503/code_-1' },
    ],
    [
      'unknown token: 404 -9',
      answer(404, { code: -9, message: 'unknown token' }),
      { kind: 'NOT_FOUND' },
    ],
    ['404 without a code', answer(404, 'Not Found'), { kind: 'NOT_FOUND' }],
    [
      'code -1 even with HTTP 200',
      answer(200, { code: -1, message: 'service unavailable' }),
      { kind: 'UNAVAILABLE', reason: 'HTTP_200/code_-1' },
    ],
    [
      'an unknown code',
      answer(200, { code: 7 }),
      { kind: 'UNAVAILABLE', reason: 'HTTP_200/code_7' },
    ],
    [
      'a gateway error page',
      answer(502, '<html>Bad Gateway</html>'),
      { kind: 'UNAVAILABLE', reason: 'HTTP_502' },
    ],
  ])('%s', (_name, input, expected) => {
    expect(classifyVerify(input)).toEqual(expected);
  });

  it.each([
    ['100 without a refId', { code: 100, amount: '1000000' }],
    ['100 without an amount', { code: 100, refId: 'R1' }],
    [
      '101 with an unparseable amount',
      { code: 101, amount: '1e6', refId: 'R1' },
    ],
    ['100 with an empty refId', { code: 100, amount: '1', refId: '' }],
  ])('never credits on an unreadable body: %s', (_name, body) => {
    expect(classifyVerify(answer(200, body))).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'unreadable verify body',
    });
  });

  it('accepts a JSON number amount (providers send numbers or strings)', () => {
    expect(
      classifyVerify(answer(200, { code: 100, amount: 5000, refId: 'R1' })),
    ).toEqual({ kind: 'OK', amount: Money.rial(5000n), refId: 'R1' });
  });
});

describe('classifyCreate (PSP-02, PSP-03)', () => {
  it('201 with a token and link → CREATED (evidence PSP-01)', () => {
    expect(
      classifyCreate(
        answer(201, {
          code: 100,
          token: 'A053e4cda8c3f475a8',
          paymentUrl: 'http://sim:8080/psp/pay/A053e4cda8c3f475a8',
        }),
      ),
    ).toEqual({
      kind: 'CREATED',
      token: 'A053e4cda8c3f475a8',
      paymentUrl: 'http://sim:8080/psp/pay/A053e4cda8c3f475a8',
    });
  });

  it.each([
    [
      '400 -12 below minimum (evidence PSP-02)',
      answer(400, { code: -12, message: 'amount below minimum' }),
      { kind: 'REJECTED', code: -12, message: 'amount below minimum' },
    ],
    [
      '400 -11 not an integer (evidence PSP-02)',
      answer(400, { code: -11, message: 'amount must be a positive integer' }),
      {
        kind: 'REJECTED',
        code: -11,
        message: 'amount must be a positive integer',
      },
    ],
    [
      '400 -13 callbackUrl required',
      answer(400, { code: -13, message: 'callbackUrl required' }),
      { kind: 'REJECTED', code: -13, message: 'callbackUrl required' },
    ],
    [
      '422 with no code',
      answer(422, {}),
      { kind: 'REJECTED', code: null, message: null },
    ],
  ])('%s → REJECTED', (_name, input, expected) => {
    expect(classifyCreate(input)).toEqual(expected);
  });

  it.each([
    ['503', answer(503, { code: -1 }), 'HTTP_503/code_-1'],
    ['500', answer(500, 'oops'), 'HTTP_500'],
    ['429 throttling is not a rejection', answer(429, {}), 'HTTP_429'],
    ['408', answer(408, ''), 'HTTP_408'],
    ['a 201 with no token', answer(201, { code: 100 }), 'unreadable 201 body'],
    [
      'a 201 with an empty token',
      answer(201, { token: '', paymentUrl: 'x' }),
      'unreadable 201 body',
    ],
    ['a 201 that is not JSON', answer(201, 'ok'), 'unreadable 201 body'],
  ])('%s → UNAVAILABLE, never a failed deposit', (_name, input, reason) => {
    expect(classifyCreate(input)).toEqual({ kind: 'UNAVAILABLE', reason });
  });
});

describe('classifyLookup', () => {
  const payment = (status: string, refId: string | null = null) => ({
    token: 'A086',
    orderId: 'ord-1',
    status,
    amount: '1000000',
    refId,
  });

  it.each(['INIT', 'PAID', 'VERIFIED', 'FAILED', 'REVERSED'])(
    '200 %s → FOUND (evidence PSP-10)',
    (status) => {
      expect(
        classifyLookup(answer(200, payment(status, '4098738143'))),
      ).toEqual({
        kind: 'FOUND',
        status,
        amount: Money.rial(1_000_000n),
        refId: '4098738143',
      });
    },
  );

  it('refId null while INIT', () => {
    expect(classifyLookup(answer(200, payment('INIT')))).toMatchObject({
      kind: 'FOUND',
      refId: null,
    });
  });

  it('404 → NOT_FOUND', () => {
    expect(classifyLookup(answer(404, { code: -9 }))).toEqual({
      kind: 'NOT_FOUND',
    });
  });

  it.each([
    ['an unknown status', answer(200, payment('MAYBE'))],
    ['an unreadable amount', answer(200, { ...payment('PAID'), amount: 'x' })],
    ['a missing amount', answer(200, { token: 'A', status: 'PAID' })],
    ['a 503', answer(503, { code: -1 })],
    ['a non-JSON 200', answer(200, 'hello')],
  ])('%s → UNAVAILABLE', (_name, input) => {
    expect(classifyLookup(input).kind).toBe('UNAVAILABLE');
  });
});

describe('classifySettlement (PSP-12)', () => {
  const csv = 'a,b,c\r\n1,2,3\r\n';

  it('a 200 with text is the file', () => {
    expect(classifySettlement(answer(200, csv))).toEqual({
      kind: 'FOUND',
      csv,
    });
  });

  it.each([
    ['a 503', answer(503, { code: -1 }), 'HTTP_503/code_-1'],
    ['a 404', answer(404, { code: -404 }), 'HTTP_404/code_-404'],
    ['a 500 with a page', answer(500, '<html>oops</html>'), 'HTTP_500'],
    [
      'a 200 with a JSON error object',
      answer(200, { code: -404 }),
      'not a text body',
    ],
    ['a 200 with a JSON number', answer(200, 5), 'not a text body'],
    ['a 200 with nothing', answer(200, null), 'not a text body'],
    ['a 200 with blank text', answer(200, '  \r\n'), 'not a text body'],
  ])('%s is UNAVAILABLE: there is no file', (_name, input, reason) => {
    expect(classifySettlement(input)).toEqual({ kind: 'UNAVAILABLE', reason });
  });
});
