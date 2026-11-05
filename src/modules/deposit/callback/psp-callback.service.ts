import { Injectable, Logger } from '@nestjs/common';
import { isUuid } from '../../../common/ids';
import { TransactionRunner, Tx } from '../../../database/transaction-runner';
import {
  InboundEvents,
  InboundOutcome,
} from '../../integrations/inbound-events';
import { JOBS_EXCHANGE, OutboxService } from '../../messaging';
import {
  CallbackTarget,
  DepositsRepository,
} from '../repositories/deposits.repository';

/** Marks a sync job started by a PSP callback. */
export const CALLBACK_TRIGGER = 'CALLBACK';

export type CallbackHeaders = Readonly<
  Record<string, string | string[] | undefined>
>;

/**
 * @class PspCallbackService
 * @description `POST /webhooks/psp/callback/:depositId`. The PSP's callbacks are unsigned, duplicated, sometimes missing, sometimes lying
 * (`NOK` for a paid payment, an amount ×10), so a callback is only a hint. In one transaction it:
 * 1. matches the path id, the body's `orderId` and the body's `token` to a stored deposit;
 * 2. records the delivery as received, whatever happened;
 * 3. for a match on a `PENDING` deposit, makes it due now and queues `job.deposit.sync`.
 * The body's status and amount are never read as truth: the sync pulls both from the PSP. Nothing slow happens here.
 */
@Injectable()
export class PspCallbackService {
  private readonly logger = new Logger(PspCallbackService.name);

  constructor(
    private readonly runner: TransactionRunner,
    private readonly deposits: DepositsRepository,
    private readonly inbound: InboundEvents,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * @function receive
   * @param depositId - the id from the callback URL
   * @param rawBody - the body exactly as received
   * @param headers - the request headers, kept as evidence
   * @returns what was done with it
   */
  receive(
    depositId: string,
    rawBody: Buffer,
    headers: CallbackHeaders,
  ): Promise<InboundOutcome> {
    const raw = rawBody.toString('utf8');
    const body = parse(raw);
    return this.runner.run(async (tx) => {
      const target = isUuid(depositId)
        ? await this.deposits.findCallbackTarget(tx, depositId)
        : null;
      const outcome = await this.decide(tx, target, body);
      await this.inbound.record(tx, {
        source: 'PSP_CALLBACK',
        eventId: null,
        reference: depositId,
        signatureValid: null,
        headers,
        rawBody: raw,
        outcome,
      });
      return outcome;
    });
  }

  private async decide(
    tx: Tx,
    target: CallbackTarget | null,
    body: Record<string, unknown> | null,
  ): Promise<InboundOutcome> {
    if (!target) return 'UNKNOWN_REFERENCE';
    if (
      target.pspToken === null ||
      body?.orderId !== target.id ||
      body.token !== target.pspToken
    ) {
      this.logger.warn(
        `callback for deposit ${target.id} does not match its token or orderId: ignored`,
      );
      return 'MISMATCH';
    }

    if (target.status === 'PENDING') {
      if (await this.deposits.scheduleCheckNow(tx, target.id)) {
        await this.outbox.add(tx, {
          exchange: JOBS_EXCHANGE,
          routingKey: 'job.deposit.sync',
          aggregate: { type: 'DEPOSIT', id: target.id },
          payload: { depositId: target.id, trigger: CALLBACK_TRIGGER },
        });
        return 'ACCEPTED';
      }
      return 'IGNORED_FINAL';
    }

    const expired =
      target.status === 'FAILED' && target.failureReason === 'EXPIRED';
    if (expired && body.status === 'OK') {
      await this.deposits.flagLatePayment(tx, target.id);
      this.logger.error(
        `ALERT ${target.id}: callback says paid after the deposit expired; it will not be verified, so the PSP returns the money to the payer`,
      );
    }
    return 'IGNORED_FINAL';
  }
}

function parse(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
