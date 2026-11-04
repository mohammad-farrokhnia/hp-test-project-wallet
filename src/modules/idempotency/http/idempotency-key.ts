import {
  applyDecorators,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  Post,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppError } from '../../../common/errors';
import { StoredResponse } from '../idempotency.types';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';

/** 1–255 printable ASCII characters; mirrors `idempotency_keys_key_format`. */
const KEY_FORMAT = /^[ -~]{1,255}$/;

/** Route metadata: the handler is a financial POST and requires the key. */
export const FINANCIAL_POST = 'idempotency:financial-post';
/** Route metadata: the POST is deliberately exempt; the value says why. */
export const IDEMPOTENCY_EXEMPT = 'idempotency:exempt';

/**
 * @function readIdempotencyKey
 * @description Reads and checks the header.
 * @param req - the request
 * @returns the key
 * @throws {AppError} `IDEMPOTENCY_KEY_REQUIRED` (400) when missing or empty; `VALIDATION_ERROR` (400) when malformed
 */
export function readIdempotencyKey(req: Request): string {
  const key = req.header(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined || key === '') {
    throw new AppError('IDEMPOTENCY_KEY_REQUIRED');
  }
  if (!KEY_FORMAT.test(key)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${IDEMPOTENCY_KEY_HEADER} must be 1-255 printable ASCII characters`,
    );
  }
  return key;
}

/**
 * @class IdempotencyKeyGuard
 * @description Refuses a financial POST without a valid key before anything else runs, body validation included. Applied by `@FinancialPost()`.
 */
@Injectable()
export class IdempotencyKeyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    readIdempotencyKey(ctx.switchToHttp().getRequest<Request>());
    return true;
  }
}

/**
 * @function FinancialPost
 * @description `@Post(path)` for a request that moves money: requires `Idempotency-Key` and marks the route so the route audit can prove no financial POST was missed.
 * @param path - the route path
 */
export function FinancialPost(path?: string): MethodDecorator {
  return applyDecorators(
    Post(path),
    SetMetadata(FINANCIAL_POST, true),
    UseGuards(IdempotencyKeyGuard),
  );
}

/**
 * @function IdempotencyExempt
 * @description Marks a POST, or a whole controller, that must not require the key: provider webhooks and reconciliation. The reason is kept for the route audit.
 * @param reason - why, e.g. "provider webhook: the provider never sends the header"
 */
export function IdempotencyExempt(
  reason: string,
): ClassDecorator & MethodDecorator {
  return SetMetadata(IDEMPOTENCY_EXEMPT, reason);
}

/** The checked `Idempotency-Key` as a handler parameter. */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string =>
    readIdempotencyKey(ctx.switchToHttp().getRequest<Request>()),
);

/**
 * @function sendIdempotent
 * @description Sets the status of a fresh or replayed response, and `Idempotent-Replayed: true` on a replay. Use with `@Res({ passthrough: true })`.
 * @param res - the Express response
 * @param response - the status and body to send
 * @param replayed - true when the body comes from a stored response
 * @returns the body, for Nest to serialise
 */
export function sendIdempotent(
  res: Response,
  response: StoredResponse,
  replayed: boolean,
): unknown {
  res.status(response.status);
  if (replayed) res.setHeader(REPLAYED_HEADER, 'true');
  return response.body;
}
