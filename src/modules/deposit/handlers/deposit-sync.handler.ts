import { Inject, Injectable, Logger } from '@nestjs/common';
import { Tx, TransactionRunner } from '../../../database/transaction-runner';
import { PSP_CLIENT } from '../../integrations/psp';
import type { PspClient } from '../../integrations/psp';
import { LedgerService } from '../../ledger';
import { Envelope, JobHandler } from '../../messaging';
import {
  decideDepositSync,
  Observation,
} from '../domain/deposit-state-machine';
import {
  DepositLifecycleRepository,
  SyncRow,
} from '../repositories/deposit-lifecycle.repository';

const SECOND_MS = 1000;

/**
 * @class DepositSyncHandler
 * @description Consumer of `job.deposit.sync`: asks the PSP, then moves a `PENDING` deposit forward.
 * 1. Without a lock, load the deposit; anything but `PENDING` is already settled and costs no PSP call.
 * 2. Outside any transaction: `getPayment`, and `verify` when the PSP says PAID or VERIFIED.
 * 3. One transaction: lock the row, decide on it AS LOCKED (`decideDepositSync`), apply with compare-and-set, and book `DEPOSIT_CREDIT` for the verified amount.
 * A callback's body never reaches this code (the job carries ids only), so a forged status or amount cannot matter.
 * Credited once however often this runs: the compare-and-set from `PENDING`, `UNIQUE (kind, ref)` on journals and `UNIQUE (psp_ref_id)` on deposits.
 * A bank reference that already credited another deposit throws, the job retries and then dead-letters: money is never booked twice.
 */
@Injectable()
export class DepositSyncHandler implements JobHandler {
  readonly job = 'job.deposit.sync';
  private readonly logger = new Logger(DepositSyncHandler.name);

  constructor(
    private readonly runner: TransactionRunner,
    private readonly lifecycle: DepositLifecycleRepository,
    private readonly ledger: LedgerService,
    @Inject(PSP_CLIENT) private readonly psp: PspClient,
  ) {}

  async handle(envelope: Envelope): Promise<void> {
    const id = envelope.payload.depositId ?? envelope.aggregateId;
    const seen = await this.runner.run(
      (tx) => this.lifecycle.findForSync(tx, id),
      { readOnly: true },
    );
    if (seen?.status !== 'PENDING' || seen.pspToken === null) return;

    const observation = await this.observe(seen.pspToken);
    await this.runner.run((tx) => this.apply(tx, id, observation));
  }

  private async observe(token: string): Promise<Observation> {
    const lookup = await this.psp.getPayment(token);
    if (lookup.kind === 'UNAVAILABLE') return { kind: 'PSP_UNAVAILABLE' };
    if (lookup.kind === 'NOT_FOUND') return { kind: 'UNKNOWN_TOKEN' };
    const paid = lookup.status === 'PAID' || lookup.status === 'VERIFIED';
    return {
      kind: 'STATUS',
      status: lookup.status,
      verify: paid ? await this.psp.verify(token) : null,
    };
  }

  private async apply(
    tx: Tx,
    id: string,
    observation: Observation,
  ): Promise<void> {
    const d = await this.lifecycle.lockForSync(tx, id);
    if (d?.status !== 'PENDING') return;

    const decision = decideDepositSync(observation, {
      requested: d.amount,
      checkAttempts: d.checkAttempts,
      ageSeconds: (Date.now() - d.createdAt.getTime()) / SECOND_MS,
      expired: Date.now() >= d.expiresAt.getTime(),
    });
    const applied = await this.lifecycle.applySync(tx, id, {
      status: decision.to,
      failureReason: decision.failureReason,
      credited: decision.credit,
      pspStatus: decision.pspStatus,
      review: decision.review,
      paidSeen: decision.paidSeen,
      nextCheckSeconds: decision.nextCheckSeconds,
    });
    if (!applied) return;

    if (decision.credit) await this.credit(tx, d, decision.credit);
    this.report(d, decision.rule, decision.to, decision.review);
  }

  private async credit(
    tx: Tx,
    d: SyncRow,
    verified: { amount: SyncRow['amount']; refId: string },
  ): Promise<void> {
    await this.ledger.creditUser(tx, {
      userId: d.userId,
      amount: verified.amount,
      source: 'PSP_CLEARING',
      kind: 'DEPOSIT_CREDIT',
      refId: d.id,
      description: `Deposit ${d.id} (PSP ref ${verified.refId})`,
    });
  }

  private report(
    d: SyncRow,
    rule: string,
    to: string | undefined,
    review: string | undefined,
  ): void {
    if (to) {
      this.logger.log(`${d.id}: ${rule} PENDING → ${to}`);
    }
    if (review) {
      this.logger.warn(`${d.id}: ${rule} needs review (${review})`);
    }
  }
}
