import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { isUuid } from '../../../common/ids';
import { TransactionRunner } from '../../../database/transaction-runner';
import { InboundEvents } from '../../integrations/inbound-events';
import { WebhookVerifier } from '../../integrations/payout';
import { JOBS_EXCHANGE, OutboxService } from '../../messaging';
import { WithdrawalsRepository } from '../repositories/withdrawals.repository';

/** Marks a sync job started by a signed webhook: it pulls even for a final withdrawal. */
export const WEBHOOK_TRIGGER = 'WEBHOOK';

export type WebhookHeaders = Readonly<
  Record<string, string | string[] | undefined>
>;

/**
 * @class PayoutWebhookService
 * @description `POST /webhooks/payout` . A push is a hint, never the truth: a forged FAILED webhook for a transfer that SUCCEEDED was common,
 * and trusting it would release a paid transfer's money:
 * 1. verify `x-signature` over the raw bytes in constant time; invalid → record `REJECTED_SIGNATURE`, 401, nothing else changes;
 * 2. valid → in one transaction record it and, for a known withdrawal, set `next_check_at = now()` and queue `job.withdrawal.sync`. The status in the body is never applied:
 * the sync pulls the truth with a GET.
 * Nothing slow happens here, so the provider gets its 200 in milliseconds.
 */
@Injectable()
export class PayoutWebhookService {
  private readonly logger = new Logger(PayoutWebhookService.name);

  constructor(
    private readonly runner: TransactionRunner,
    private readonly verifier: WebhookVerifier,
    private readonly inbound: InboundEvents,
    private readonly withdrawals: WithdrawalsRepository,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * @function receive
   * @param rawBody - the body exactly as received
   * @param headers - the request headers, kept as evidence
   * @returns `ACCEPTED` (sync scheduled) or `UNKNOWN_REFERENCE`
   * @throws {AppError} `INVALID_SIGNATURE` (401) after recording the delivery
   */
  async receive(
    rawBody: Buffer,
    headers: WebhookHeaders,
  ): Promise<'ACCEPTED' | 'UNKNOWN_REFERENCE'> {
    const signature = single(headers['x-signature']);
    const valid = this.verifier.verify(rawBody, signature);
    const body = parse(rawBody);
    const requestId =
      typeof body?.requestId === 'string' ? body.requestId : null;
    const eventId =
      single(headers['x-event-id']) ??
      (typeof body?.eventId === 'string' ? body.eventId : null);
    const evidence = {
      source: 'PAYOUT_WEBHOOK' as const,
      eventId,
      reference: requestId,
      signatureValid: valid,
      headers,
      rawBody: rawBody.toString('utf8'),
    };

    if (!valid) {
      await this.runner.run((tx) =>
        this.inbound.record(tx, { ...evidence, outcome: 'REJECTED_SIGNATURE' }),
      );
      this.logger.warn(
        `payout webhook for ${requestId ?? '?'} with a bad signature: rejected`,
      );
      throw new AppError('INVALID_SIGNATURE');
    }

    return this.runner.run(async (tx) => {
      const known =
        requestId !== null &&
        isUuid(requestId) &&
        (await this.withdrawals.scheduleCheck(tx, requestId, 0));
      const outcome = known ? 'ACCEPTED' : 'UNKNOWN_REFERENCE';
      await this.inbound.record(tx, { ...evidence, outcome });
      if (known) {
        await this.outbox.add(tx, {
          exchange: JOBS_EXCHANGE,
          routingKey: 'job.withdrawal.sync',
          aggregate: { type: 'WITHDRAWAL', id: requestId },
          payload: { withdrawalId: requestId, trigger: WEBHOOK_TRIGGER },
        });
      }
      return outcome;
    });
  }
}

function single(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function parse(raw: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw.toString('utf8'));
    return typeof v === 'object' && v !== null
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
