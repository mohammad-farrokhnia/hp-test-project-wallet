import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../common/errors';
import { uuidv7 } from '../../common/ids';
import { Money } from '../../common/money';
import { AppConfig } from '../../config/app-config';
import { TransactionRunner, Tx } from '../../database/transaction-runner';
import {
  IdempotencyService,
  ResourceRef,
  StoredResponse,
} from '../idempotency';
import { PSP_CLIENT } from '../integrations/psp';
import type { CreatePaymentOutcome, PspClient } from '../integrations/psp';
import {
  DepositRecord,
  DepositsRepository,
} from './repositories/deposits.repository';

export const DEPOSITS_SCOPE = 'POST /deposits';

export interface CreateDeposit {
  readonly userId: string;
  readonly amount: Money;
  readonly body: unknown;
}

export interface DepositReply {
  readonly response: StoredResponse;
  readonly replayed: boolean;
}

/** The deposit a create is working on: what the PSP call needs. */
interface Target {
  readonly id: string;
  readonly amount: Money;
}

type Begun =
  | { readonly kind: 'ANSWERED'; readonly response: StoredResponse }
  | { readonly kind: 'CALL_PSP'; readonly target: Target };

type Finished =
  | { readonly kind: 'STORED'; readonly response: StoredResponse }
  | { readonly kind: 'UNAVAILABLE' };

/**
 * @class DepositService
 * @description Deposit use cases. Creating one is two-phase because the PSP call must not sit inside a transaction.
 */
@Injectable()
export class DepositService {
  private readonly logger = new Logger(DepositService.name);
  private readonly leaseSeconds: number;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly idempotency: IdempotencyService,
    private readonly deposits: DepositsRepository,
    @Inject(PSP_CLIENT) private readonly psp: PspClient,
    private readonly config: AppConfig,
  ) {
    this.leaseSeconds = config.timing.depositCreateLeaseSeconds;
    if (this.leaseSeconds * 1000 <= config.http.timeoutMs) {
      throw new Error(
        `DEPOSIT_CREATE_LEASE_SECONDS (${this.leaseSeconds}) must outlast HTTP_TIMEOUT_MS (${config.http.timeoutMs}), or a live PSP call could be repeated`,
      );
    }
  }

  /**
   * @function create
   * @description `POST /deposits`. Before anything, not stored: 422 `BELOW_MINIMUM`. Then:
   * 1. transaction 1: claim the key with a lease; for a new key, insert the `CREATED` deposit and attach it to the key; commit;
   * 2. the PSP call, outside any transaction;
   * 3. transaction 2, by outcome: issued → `PENDING` with token and link; rejected → `FAILED (PSP_REJECTED)`; both complete the key with a 201. Unavailable → release the lease, answer 503 (not stored).
   * A crash between 1 and 3 leaves the key `IN_PROGRESS` and the deposit `CREATED`; once the lease ends, a retry with the same key resumes that deposit with a new PSP create. A retry inside the lease gets 409.
   * @param cmd - the parsed request
   * @param key - the Idempotency-Key
   * @returns the response, fresh or replayed
   * @throws {AppError} `BELOW_MINIMUM`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`, `PROVIDER_UNAVAILABLE`
   */
  async create(cmd: CreateDeposit, key: string): Promise<DepositReply> {
    if (cmd.amount.lt(Money.rial(this.config.limits.depositMinRial))) {
      throw new AppError('BELOW_MINIMUM');
    }

    const begun = await this.runner.run((tx) => this.begin(tx, cmd, key));
    if (begun.kind === 'ANSWERED') {
      return { response: begun.response, replayed: true };
    }

    const { target } = begun;
    const outcome = await this.psp.createPayment(
      target.amount,
      target.id,
      this.callbackUrl(target.id),
    );

    const finished = await this.runner.run((tx) =>
      this.finish(tx, key, target, outcome),
    );
    if (finished.kind === 'UNAVAILABLE') {
      throw new AppError('PROVIDER_UNAVAILABLE');
    }
    return { response: finished.response, replayed: false };
  }

  /**
   * @function get
   * @returns the deposit, or `null` when unknown
   */
  get(id: string): Promise<DepositRecord | null> {
    return this.runner.run((tx) => this.deposits.findById(tx, id), {
      readOnly: true,
    });
  }

  /** Transaction 1: the claim, and the deposit it protects. */
  private async begin(tx: Tx, cmd: CreateDeposit, key: string): Promise<Begun> {
    const claim = await this.idempotency.claimWithLease(
      tx,
      { key, scope: DEPOSITS_SCOPE, body: cmd.body },
      this.leaseSeconds,
    );
    switch (claim.kind) {
      case 'REPLAY':
        return { kind: 'ANSWERED', response: claim.response };
      case 'IN_PROGRESS':
        throw new AppError('IDEMPOTENCY_IN_PROGRESS');
      case 'NEW':
        return { kind: 'CALL_PSP', target: await this.open(tx, cmd, key) };
      case 'RESUME':
        return this.resume(tx, cmd, key, claim.resource);
    }
  }

  /** Inserts the deposit and ties it to the key in the same transaction. */
  private async open(tx: Tx, cmd: CreateDeposit, key: string): Promise<Target> {
    const target = { id: uuidv7(), amount: cmd.amount };
    await this.deposits.insertCreated(tx, {
      id: target.id,
      userId: cmd.userId,
      amount: cmd.amount,
      expiresInMinutes: this.config.timing.depositExpiryMinutes,
    });
    await this.idempotency.attachResource(tx, key, depositRef(target.id));
    return target;
  }

  /**
   * An earlier attempt died or gave up. Its deposit is still `CREATED`, so the PSP create is simply made again. If something else already moved the deposit, answer from its state instead.
   */
  private async resume(
    tx: Tx,
    cmd: CreateDeposit,
    key: string,
    resource: ResourceRef | null,
  ): Promise<Begun> {
    if (!resource) {
      return { kind: 'CALL_PSP', target: await this.open(tx, cmd, key) };
    }
    const deposit = await this.deposits.findById(tx, resource.id, true);
    if (!deposit) {
      throw new Error(`idempotency key ${key} points at a missing deposit`);
    }
    if (deposit.status === 'CREATED') {
      return {
        kind: 'CALL_PSP',
        target: { id: deposit.id, amount: deposit.amount },
      };
    }
    const response = settledResponse(deposit);
    await this.idempotency.complete(tx, key, response, depositRef(deposit.id));
    return { kind: 'ANSWERED', response };
  }

  /** Transaction 2: record what the PSP said, and complete the key. */
  private async finish(
    tx: Tx,
    key: string,
    target: Target,
    outcome: CreatePaymentOutcome,
  ): Promise<Finished> {
    if (outcome.kind === 'UNAVAILABLE') {
      this.logger.warn(
        `deposit ${target.id}: PSP unavailable (${outcome.reason}); lease released`,
      );
      await this.idempotency.releaseLease(tx, key);
      return { kind: 'UNAVAILABLE' };
    }

    const moved =
      outcome.kind === 'CREATED'
        ? await this.deposits.markPending(tx, target.id, {
            token: outcome.token,
            paymentUrl: outcome.paymentUrl,
            firstCheckInSeconds: this.config.timing.depositFirstCheckSeconds,
          })
        : await this.deposits.markFailedFromCreated(
            tx,
            target.id,
            'PSP_REJECTED',
          );
    if (!moved) throw new AppError('IDEMPOTENCY_IN_PROGRESS');

    if (outcome.kind === 'REJECTED') {
      this.logger.warn(
        `deposit ${target.id}: PSP rejected the payment (code ${outcome.code})`,
      );
    }
    const response: StoredResponse = {
      status: 201,
      body:
        outcome.kind === 'CREATED'
          ? {
              depositId: target.id,
              status: 'PENDING',
              paymentUrl: outcome.paymentUrl,
            }
          : { depositId: target.id, status: 'FAILED', paymentUrl: null },
    };
    await this.idempotency.complete(tx, key, response, depositRef(target.id));
    return { kind: 'STORED', response };
  }

  private callbackUrl(depositId: string): string {
    return `${this.config.http.publicBaseUrl}/webhooks/psp/callback/${depositId}`;
  }
}

const depositRef = (id: string): ResourceRef => ({ type: 'DEPOSIT', id });

/** The 201 a settled deposit would have answered with. */
function settledResponse(d: DepositRecord): StoredResponse {
  return {
    status: 201,
    body: { depositId: d.id, status: d.status, paymentUrl: d.paymentUrl },
  };
}
