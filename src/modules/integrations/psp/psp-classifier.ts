import { parseProviderAmount } from '../../../common/money';
import { HttpAnswer } from '../http/json-call';
import {
  CreatePaymentOutcome,
  PaymentLookup,
  PspStatus,
  SettlementOutcome,
  VerifyOutcome,
} from './psp.port';

const STATUSES: readonly PspStatus[] = [
  'INIT',
  'PAID',
  'VERIFIED',
  'FAILED',
  'REVERSED',
];

const CODE_OK = 100;
const CODE_ALREADY_VERIFIED = 101;
const CODE_NOT_PAID = -51;
const CODE_UNKNOWN_TOKEN = -9;

/** Statuses where retrying the same create is the right answer, not giving up. */
const RETRYABLE_4XX = new Set([408, 425, 429]);

type Fields = Record<string, unknown>;

const fields = (body: unknown): Fields | null =>
  typeof body === 'object' && body !== null ? (body as Fields) : null;

const codeOf = (body: unknown): number | null => {
  const code = fields(body)?.code;
  return typeof code === 'number' ? code : null;
};

const reasonFor = (answer: HttpAnswer): string => {
  const code = codeOf(answer.body);
  return code === null
    ? `HTTP_${answer.status}`
    : `HTTP_${answer.status}/code_${code}`;
};

function readAmount(raw: unknown) {
  try {
    return parseProviderAmount('IRR', raw);
  } catch {
    return null;
  }
}

/**
 * @function classifyCreate
 * @description `POST /psp/payments`: 201 with a token and link → `CREATED`; a 4xx other than throttling → `REJECTED` (nothing was created);
 * everything else, including an unreadable 201, → `UNAVAILABLE`, because the call may have created a payment we can never use or none at all.
 * @param answer - what the PSP answered
 * @returns the outcome
 */
export function classifyCreate(answer: HttpAnswer): CreatePaymentOutcome {
  const b = fields(answer.body);
  if (answer.status === 201) {
    return typeof b?.token === 'string' &&
      b.token !== '' &&
      typeof b.paymentUrl === 'string' &&
      b.paymentUrl !== ''
      ? { kind: 'CREATED', token: b.token, paymentUrl: b.paymentUrl }
      : { kind: 'UNAVAILABLE', reason: 'unreadable 201 body' };
  }
  if (
    answer.status >= 400 &&
    answer.status < 500 &&
    !RETRYABLE_4XX.has(answer.status)
  ) {
    return {
      kind: 'REJECTED',
      code: codeOf(answer.body),
      message: typeof b?.message === 'string' ? b.message : null,
    };
  }
  return { kind: 'UNAVAILABLE', reason: reasonFor(answer) };
}

/**
 * @function classifyLookup
 * @description `GET /psp/payments/{token}`: a 200 with a known status and a readable amount → `FOUND`;
 * 404 → `NOT_FOUND`; everything else → `UNAVAILABLE`.
 * @param answer - what the PSP answered
 * @returns the outcome
 */
export function classifyLookup(answer: HttpAnswer): PaymentLookup {
  if (answer.status === 404) return { kind: 'NOT_FOUND' };
  const b = fields(answer.body);
  if (answer.status !== 200) {
    return { kind: 'UNAVAILABLE', reason: reasonFor(answer) };
  }
  const status = STATUSES.find((s) => s === b?.status);
  const amount = readAmount(b?.amount);
  if (!status || !amount) {
    return { kind: 'UNAVAILABLE', reason: 'unreadable 200 body' };
  }
  return {
    kind: 'FOUND',
    status,
    amount,
    refId: typeof b?.refId === 'string' && b.refId !== '' ? b.refId : null,
  };
}

/**
 * @function classifyVerify
 * @description `POST /psp/verify`, decided by the body's `code`, because `-51` comes with HTTP 200:
 * - 100 → `OK`, 101 → `ALREADY_VERIFIED` (both carry a positive verified amount and a `refId`; one without them is `UNAVAILABLE`);
 * - -51 → `NOT_PAID`, which is also what a payment still in INIT answers, so it never decides a failure;
 * - -9 or HTTP 404 → `NOT_FOUND`;
 * - -1, HTTP 503, any other code or status → `UNAVAILABLE`: a 503 was not applied, so retrying is safe.
 * @param answer - what the PSP answered
 * @returns the outcome
 */
export function classifyVerify(answer: HttpAnswer): VerifyOutcome {
  const code = codeOf(answer.body);
  if (code === CODE_NOT_PAID) return { kind: 'NOT_PAID' };
  if (code === CODE_UNKNOWN_TOKEN || (code === null && answer.status === 404)) {
    return { kind: 'NOT_FOUND' };
  }
  if (
    answer.status === 200 &&
    (code === CODE_OK || code === CODE_ALREADY_VERIFIED)
  ) {
    const b = fields(answer.body);
    const amount = readAmount(b?.amount);
    const refId = b?.refId;
    if (
      !amount ||
      !amount.isPositive() ||
      typeof refId !== 'string' ||
      refId === ''
    ) {
      return { kind: 'UNAVAILABLE', reason: 'unreadable verify body' };
    }
    return {
      kind: code === CODE_OK ? 'OK' : 'ALREADY_VERIFIED',
      amount,
      refId,
    };
  }
  return { kind: 'UNAVAILABLE', reason: reasonFor(answer) };
}

/**
 * @function classifySettlement
 * @description `GET /psp/settlement`: a 200 whose body is text → `FOUND`. The file is CSV, so a JSON body (an error object, a parsed value)
 * or an empty one means this is not the file; anything but 200 → `UNAVAILABLE`. What the text contains is for the settlement parser to judge.
 * @param answer - what the PSP answered
 * @returns the outcome
 */
export function classifySettlement(answer: HttpAnswer): SettlementOutcome {
  if (answer.status !== 200) {
    return { kind: 'UNAVAILABLE', reason: reasonFor(answer) };
  }
  if (typeof answer.body !== 'string' || answer.body.trim() === '') {
    return { kind: 'UNAVAILABLE', reason: 'not a text body' };
  }
  return { kind: 'FOUND', csv: answer.body };
}
