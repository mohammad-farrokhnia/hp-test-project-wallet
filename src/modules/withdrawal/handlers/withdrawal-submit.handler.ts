import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { Tx, TransactionRunner } from '../../../database/transaction-runner';
import {
  PAYOUT_CLIENT,
  type PayoutClient,
  type PayoutRequest,
  type SubmitOutcome,
  type TransferSnapshot,
} from '../../integrations/payout';
import {
  Envelope,
  JOBS_EXCHANGE,
  JobHandler,
  OutboxService,
} from '../../messaging';
import { maskDestination } from '../domain/destination';
import {
  AFTER_ACCEPTED_SECONDS,
  AFTER_MISMATCH_SECONDS,
  afterAmbiguousSeconds,
} from '../domain/submit-schedule';
import {
  AttemptOutcome,
  PayoutAttemptsRepository,
} from '../repositories/payout-attempts.repository';
import { WithdrawalLifecycleRepository } from '../repositories/withdrawal-lifecycle.repository';
import { WithdrawalsRepository } from '../repositories/withdrawals.repository';

/** A submit claimed in transaction 1, to be sent and then recorded. */
interface Claimed {
  readonly attemptNo: number;
  readonly request: PayoutRequest;
}

/**
 * @class WithdrawalSubmitHandler
 * @description Consumer of `job.withdrawal.submit`. Never holds a transaction across the HTTP call:
 * 1. transaction 1: lock the withdrawal `SKIP LOCKED` (another worker has it: stop); go on only if PENDING, or SUBMITTING with no attempt in flight;
 * open attempt n with the exact body, move to SUBMITTING, commit;
 * 2. `PayoutClient.submit` with the withdrawal id as `requestId`, never regenerated;
 * 3. transaction 2: close the attempt, then, if still SUBMITTING:
 *    - ACCEPTED, or REPLAYED with matching fields → PROCESSING, check in 10 s;
 *    - REPLAYED with other fields → stays SUBMITTING, `needs_review = REPLAY_MISMATCH`, check in 5 min;
 *    - REJECTED → stays SUBMITTING, sync now: FAILED only after a GET confirms 404;
 *    - AMBIGUOUS (503, timeout, reset) → stays SUBMITTING, check by backoff. **Never FAILED**.
 * Money never moves here: it stays FROZEN until a sync settles or releases it.
 */
@Injectable()
export class WithdrawalSubmitHandler implements JobHandler {
  readonly job = 'job.withdrawal.submit';
  private readonly logger = new Logger(WithdrawalSubmitHandler.name);
  private readonly leaseSeconds: number;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly withdrawals: WithdrawalsRepository,
    private readonly lifecycle: WithdrawalLifecycleRepository,
    private readonly attempts: PayoutAttemptsRepository,
    private readonly outbox: OutboxService,
    @Inject(PAYOUT_CLIENT) private readonly payout: PayoutClient,
    config: AppConfig,
  ) {
    this.leaseSeconds = config.timing.withdrawalSubmitLeaseSeconds;
    if (this.leaseSeconds * 1000 <= config.http.timeoutMs) {
      throw new Error(
        `WITHDRAWAL_SUBMIT_LEASE_SECONDS (${this.leaseSeconds}) must outlast HTTP_TIMEOUT_MS (${config.http.timeoutMs}), or a live call could be resubmitted`,
      );
    }
  }

  async handle(envelope: Envelope): Promise<void> {
    const id = envelope.payload.withdrawalId ?? envelope.aggregateId;
    const claimed = await this.runner.run((tx) => this.claim(tx, id));
    if (!claimed) return;

    const outcome = await this.payout.submit(claimed.request);
    await this.runner.run((tx) => this.record(tx, claimed, outcome));
  }

  private async claim(tx: Tx, id: string): Promise<Claimed | null> {
    const w = await this.lifecycle.lockForSubmit(tx, id);
    if (!w) return null; // unknown, or another worker holds it
    const eligible =
      w.status === 'PENDING' ||
      (w.status === 'SUBMITTING' &&
        !(await this.attempts.inFlight(tx, id, this.leaseSeconds)));
    if (!eligible) return null;

    const attemptNo = w.submitAttempts + 1;
    const request: PayoutRequest = {
      requestId: w.id,
      destinationType: w.destinationType,
      destination: w.destination,
      amount: w.amount,
    };
    await this.attempts.open(
      tx,
      id,
      attemptNo,
      this.payout.requestBody(request),
    );
    await this.lifecycle.startSubmitting(tx, id, attemptNo, this.leaseSeconds);
    this.logger.log(
      `submitting ${id} attempt ${attemptNo} to ${maskDestination(w.destination)}`,
    );
    return { attemptNo, request };
  }

  private async record(tx: Tx, c: Claimed, o: SubmitOutcome): Promise<void> {
    const id = c.request.requestId;
    const outcome = attemptOutcome(o);
    await this.attempts.close(tx, {
      withdrawalId: id,
      attemptNo: c.attemptNo,
      outcome,
      httpStatus: o.httpStatus,
      error: o.error,
      responseBody: o.responseBody,
    });
    const status = await this.lifecycle.lockStatus(tx, id);
    if (status !== 'SUBMITTING') return;

    switch (o.kind) {
      case 'REPLAYED':
        if (o.mismatches.length > 0) {
          this.logger.warn(
            `${id}: replay differs in ${o.mismatches.join(', ')}; flagged for review`,
          );
          await this.lifecycle.flagReplayMismatch(
            tx,
            id,
            AFTER_MISMATCH_SECONDS,
          );
          return;
        }
        await this.markProcessing(tx, id, o.snapshot);
        return;
      case 'ACCEPTED':
        await this.markProcessing(tx, id, o.snapshot);
        return;
      case 'REJECTED':
        this.logger.warn(`${id}: rejected (${o.error}); a GET decides (W6)`);
        await this.withdrawals.scheduleCheck(tx, id, 0);
        await this.outbox.add(tx, {
          exchange: JOBS_EXCHANGE,
          routingKey: 'job.withdrawal.sync',
          aggregate: { type: 'WITHDRAWAL', id },
          payload: { withdrawalId: id },
        });
        return;
      case 'AMBIGUOUS':
        this.logger.warn(`${id}: ambiguous (${o.reason}); stays SUBMITTING`);
        await this.withdrawals.scheduleCheck(
          tx,
          id,
          afterAmbiguousSeconds(c.attemptNo),
        );
        return;
    }
  }

  private markProcessing(
    tx: Tx,
    id: string,
    s: TransferSnapshot,
  ): Promise<void> {
    return this.lifecycle.markProcessing(
      tx,
      id,
      { status: s.status, trackingId: s.trackingId },
      AFTER_ACCEPTED_SECONDS,
    );
  }
}

function attemptOutcome(o: SubmitOutcome): AttemptOutcome {
  if (o.kind === 'REPLAYED')
    return o.mismatches.length > 0 ? 'MISMATCH' : 'REPLAYED';
  return o.kind;
}
