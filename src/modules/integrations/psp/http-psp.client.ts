import { Logger } from '@nestjs/common';
import { Money, toProviderAmount } from '../../../common/money';
import { callJson, describeFailure, HttpAnswer } from '../http/json-call';
import {
  classifyCreate,
  classifyLookup,
  classifyVerify,
} from './psp-classifier';
import {
  CreatePaymentOutcome,
  PaymentLookup,
  PspClient,
  VerifyOutcome,
} from './psp.port';

/**
 * @class HttpPspClient
 * @description Calls the PSP and hands every answer to the classifiers; the quirks live there.
 * A transport failure (timeout, reset) is `UNAVAILABLE`, never a failure of the deposit.
 * Amounts go out as integer rial strings (PSP-01, PSP-02). Every call has a timeout.
 */
export class HttpPspClient implements PspClient {
  private readonly logger = new Logger(HttpPspClient.name);

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async createPayment(
    amount: Money,
    orderId: string,
    callbackUrl: string,
  ): Promise<CreatePaymentOutcome> {
    const answer = await this.send('create', orderId, 'POST', '/psp/payments', {
      amount: toProviderAmount(amount),
      orderId,
      callbackUrl,
    });
    return 'reason' in answer ? answer : classifyCreate(answer);
  }

  async getPayment(token: string): Promise<PaymentLookup> {
    const answer = await this.send(
      'status',
      token,
      'GET',
      `/psp/payments/${encodeURIComponent(token)}`,
    );
    return 'reason' in answer ? answer : classifyLookup(answer);
  }

  async verify(token: string): Promise<VerifyOutcome> {
    const answer = await this.send('verify', token, 'POST', '/psp/verify', {
      token,
    });
    return 'reason' in answer ? answer : classifyVerify(answer);
  }

  private async send(
    what: string,
    subject: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<HttpAnswer | { kind: 'UNAVAILABLE'; reason: string }> {
    try {
      return await callJson(this.baseUrl, this.timeoutMs, method, path, body);
    } catch (err) {
      const reason = describeFailure(err);
      this.logger.warn(`psp ${what} ${subject}: ${reason}; unavailable`);
      return { kind: 'UNAVAILABLE', reason };
    }
  }
}
