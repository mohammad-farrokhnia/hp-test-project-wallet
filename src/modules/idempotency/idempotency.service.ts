import { Injectable } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { AppError } from '../../common/errors';
import { Tx } from '../../database/transaction-runner';
import { fingerprint } from './domain/fingerprint';
import {
  ClaimRequest,
  ClaimResult,
  LeaseClaimResult,
  ResourceRef,
  StoredResponse,
} from './idempotency.types';
import {
  IdempotencyKeysRepository,
  KeyRow,
} from './repositories/idempotency-keys.repository';

const LOCK_NOT_AVAILABLE = '55P03';

/**
 * @class IdempotencyService
 * @description Makes a request with an Idempotency-Key take effect once.
 *  The key row is written in the caller's transaction, together with the effect and the stored response.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly keys: IdempotencyKeysRepository) {}

  /**
   * @function claim
   * @description For single-transaction endpoints. Inserts the key in the caller's transaction. A concurrent twin blocks on the key until the first transaction commits, then replays its response; if the first rolls back, the twin gets `NEW`.
   * @param tx - the caller's transaction; call this before any other lock
   * @param req - key, scope and body
   * @returns `NEW` (do the work, then `complete`) or `REPLAY`
   * @throws {AppError} `IDEMPOTENCY_KEY_REUSED` (422) for a different body or route; `IDEMPOTENCY_IN_PROGRESS` (409) when the twin holds the key past `lock_timeout`, or a leased create is still running
   */
  async claim(tx: Tx, req: ClaimRequest): Promise<ClaimResult> {
    const fp = fingerprint(req.scope, req.body);
    if (await this.insert(tx, req, fp)) return { kind: 'NEW' };

    const row = await this.lockExisting(tx, req.key, fp);
    if (row.status === 'COMPLETED') return replay(row);
    throw new AppError('IDEMPOTENCY_IN_PROGRESS');
  }

  /**
   * @function claimWithLease
   * @description For the two-phase deposit create only. Run it in the transaction that also inserts the deposit and calls `attachResource`, then commit before the provider call: the key stays `IN_PROGRESS`, protected by a lease of `leaseSeconds`. A twin within the lease gets `IN_PROGRESS`; a retry after the lease ended (released, or the earlier attempt died) gets `RESUME` and a new lease.
   * @param tx - the caller's transaction
   * @param req - key, scope and body
   * @param leaseSeconds - how long an attempt may run before a retry takes over
   * @returns `NEW`, `REPLAY`, `IN_PROGRESS` or `RESUME`
   * @throws {AppError} `IDEMPOTENCY_KEY_REUSED` (422), `IDEMPOTENCY_IN_PROGRESS` (409) on lock timeout
   */
  async claimWithLease(
    tx: Tx,
    req: ClaimRequest,
    leaseSeconds: number,
  ): Promise<LeaseClaimResult> {
    const fp = fingerprint(req.scope, req.body);
    if (await this.insert(tx, req, fp, leaseSeconds)) return { kind: 'NEW' };

    const row = await this.lockExisting(tx, req.key, fp);
    if (row.status === 'COMPLETED') return replay(row);
    if (!row.leaseFree) return { kind: 'IN_PROGRESS' };
    await this.keys.renewLease(tx, req.key, leaseSeconds);
    return { kind: 'RESUME', resource: row.resource };
  }

  /**
   * @function attachResource
   * @description Records the record a leased request created, so `RESUME` can hand it back.
   */
  async attachResource(
    tx: Tx,
    key: string,
    resource: ResourceRef,
  ): Promise<void> {
    await this.keys.attachResource(tx, key, resource);
  }

  /**
   * @function complete
   * @description Stores the exact response to replay. Store 2xx and state-dependent 422s; never 400s or 5xx.
   * @param tx - the transaction that claimed (or resumed) the key
   * @param key - the Idempotency-Key
   * @param response - status and body as sent to the client
   * @param resource - the record the request created, if any
   * @throws {Error} when the key is not `IN_PROGRESS`: a caller bug
   */
  async complete(
    tx: Tx,
    key: string,
    response: StoredResponse,
    resource?: ResourceRef,
  ): Promise<void> {
    if (!(await this.keys.complete(tx, key, response, resource))) {
      throw new Error(`idempotency key ${key} is not in progress`);
    }
  }

  /**
   * @function releaseLease
   * @description After an ambiguous provider failure: ends the lease now so the client's retry resumes at once.
   */
  async releaseLease(tx: Tx, key: string): Promise<void> {
    await this.keys.releaseLease(tx, key);
  }

  /** Inserts the claim; a wait on a twin past `lock_timeout` is a 409, not a 503. */
  private async insert(
    tx: Tx,
    req: ClaimRequest,
    fp: string,
    leaseSeconds?: number,
  ): Promise<boolean> {
    try {
      return await this.keys.insertClaim(
        tx,
        { key: req.key, scope: req.scope, fingerprint: fp },
        leaseSeconds,
      );
    } catch (err) {
      throw lockTimeoutAsInProgress(err);
    }
  }

  /** Locks the existing key and refuses it if the fingerprint differs. */
  private async lockExisting(tx: Tx, key: string, fp: string): Promise<KeyRow> {
    let row: KeyRow | null;
    try {
      row = await this.keys.lockKey(tx, key);
    } catch (err) {
      throw lockTimeoutAsInProgress(err);
    }
    if (!row) throw new AppError('IDEMPOTENCY_IN_PROGRESS');
    if (row.fingerprint !== fp) throw new AppError('IDEMPOTENCY_KEY_REUSED');
    return row;
  }
}

function replay(row: KeyRow): ClaimResult {
  if (!row.response) {
    throw new Error('completed idempotency key without a stored response');
  }
  return { kind: 'REPLAY', response: row.response };
}

function lockTimeoutAsInProgress(err: unknown): unknown {
  const code =
    err instanceof QueryFailedError
      ? (err.driverError as { code?: string } | undefined)?.code
      : undefined;
  return code === LOCK_NOT_AVAILABLE
    ? new AppError('IDEMPOTENCY_IN_PROGRESS')
    : err;
}
