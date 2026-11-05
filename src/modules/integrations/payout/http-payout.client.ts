import { Logger } from '@nestjs/common';
import {
  CurrencyCode,
  parseProviderAmount,
  toProviderAmount,
} from '../../../common/money';
import {
  LookupOutcome,
  PayoutClient,
  PayoutRequest,
  ReplayField,
  SubmitOutcome,
  TransferSnapshot,
  TransferStatus,
} from './payout.port';

const STATUSES: readonly TransferStatus[] = [
  'ACCEPTED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'RETURNED',
];

/** The answer the payout service gave to a create, when it gave one. */
interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * @class HttpPayoutClient
 * @description Turns HTTP into outcomes, per the probe findings:
 * - 202 → `ACCEPTED`; 200 → `REPLAYED`, compared field by field with what we sent,
 * because a replay with other fields silently returns the original.
 * - 400/422 → `REJECTED`: the request was refused and nothing was created.
 * - 503, timeout, connection reset, any other status, or an unreadable 2xx → `AMBIGUOUS`: 45 % of 503s and every timeout and reset had created the transfer,
 * so none of them may fail a withdrawal.
 * Every call has a timeout. Node's `fetch` keeps connections alive.
 */
export class HttpPayoutClient implements PayoutClient {
  private readonly logger = new Logger(HttpPayoutClient.name);

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  requestBody(request: PayoutRequest): Record<string, unknown> {
    return {
      requestId: request.requestId,
      type: request.destinationType === 'IBAN' ? 'IBAN' : 'CRYPTO',
      destination: request.destination,
      amount: toProviderAmount(request.amount),
      currency: request.amount.currency,
    };
  }

  async submit(request: PayoutRequest): Promise<SubmitOutcome> {
    const requestBody = this.requestBody(request);
    let answer: Answer;
    try {
      answer = await this.call('POST', '/payout/transfers', requestBody);
    } catch (err) {
      const error = describe(err);
      this.logger.warn(`submit ${request.requestId}: ${error}; ambiguous`);
      return {
        kind: 'AMBIGUOUS',
        reason: error,
        requestBody,
        httpStatus: null,
        responseBody: null,
        error,
      };
    }
    const exchange = {
      requestBody,
      httpStatus: answer.status,
      responseBody: answer.body,
    };

    if (answer.status === 202 || answer.status === 200) {
      const snapshot = toSnapshot(answer.body, request.amount.currency);
      if (!snapshot) {
        return {
          kind: 'AMBIGUOUS',
          reason: `unreadable ${answer.status} body`,
          ...exchange,
          error: null,
        };
      }
      if (answer.status === 202)
        return { kind: 'ACCEPTED', snapshot, ...exchange, error: null };
      return {
        kind: 'REPLAYED',
        snapshot,
        mismatches: compare(request, snapshot),
        ...exchange,
        error: null,
      };
    }
    if (answer.status === 400 || answer.status === 422) {
      const code = errorCode(answer.body) ?? `HTTP_${answer.status}`;
      return { kind: 'REJECTED', ...exchange, error: code };
    }
    const reason = errorCode(answer.body) ?? `HTTP_${answer.status}`;
    return { kind: 'AMBIGUOUS', reason, ...exchange, error: null };
  }

  async getTransfer(requestId: string): Promise<LookupOutcome> {
    let answer: Answer;
    try {
      answer = await this.call(
        'GET',
        `/payout/transfers/${encodeURIComponent(requestId)}`,
      );
    } catch (err) {
      return { kind: 'UNAVAILABLE', reason: describe(err) };
    }
    if (answer.status === 404) return { kind: 'NOT_FOUND' };
    if (answer.status !== 200) {
      return {
        kind: 'UNAVAILABLE',
        reason: errorCode(answer.body) ?? `HTTP_${answer.status}`,
      };
    }
    const currency = (answer.body as { currency?: unknown } | null)?.currency;
    const snapshot =
      currency === 'IRR' || currency === 'USDT'
        ? toSnapshot(answer.body, currency)
        : null;
    return snapshot
      ? { kind: 'FOUND', snapshot }
      : { kind: 'UNAVAILABLE', reason: 'unreadable 200 body' };
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Answer> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers:
        body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      // keep the raw text: an unreadable body is evidence too
    }
    return { status: res.status, body: parsed };
  }
}

/** Reads a transfer the payout service returned; `null` when it is not one. */
function toSnapshot(
  body: unknown,
  currency: CurrencyCode,
): TransferSnapshot | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.requestId !== 'string' || typeof b.destination !== 'string')
    return null;
  if (!STATUSES.includes(b.status as TransferStatus)) return null;
  if (b.currency !== currency) {
    if (b.currency !== 'IRR' && b.currency !== 'USDT') return null;
  }
  try {
    return {
      requestId: b.requestId,
      trackingId: typeof b.trackingId === 'string' ? b.trackingId : null,
      status: b.status as TransferStatus,
      reason: typeof b.reason === 'string' ? b.reason : null,
      amount: parseProviderAmount(b.currency as CurrencyCode, b.amount),
      destination: b.destination,
    };
  } catch {
    return null;
  }
}

function compare(request: PayoutRequest, s: TransferSnapshot): ReplayField[] {
  const out: ReplayField[] = [];
  if (s.requestId !== request.requestId) out.push('requestId');
  if (s.amount.currency !== request.amount.currency) out.push('currency');
  else if (!s.amount.equals(request.amount)) out.push('amount');
  if (s.destination !== request.destination) out.push('destination');
  return out;
}

function errorCode(body: unknown): string | null {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === 'string' ? e : null;
}

/** By shape, not `instanceof`: fetch's errors may come from another realm. */
function describe(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'unknown error';
  const e = err as {
    name?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timeout';
  return e.cause?.code ?? e.cause?.message ?? e.message ?? 'unknown error';
}
