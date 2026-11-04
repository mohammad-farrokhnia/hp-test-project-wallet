import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  UseGuards,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { AppConfig } from '../../config/app-config';
import { AppError } from '../errors';

export const INTERNAL_API_KEY_HEADER = 'X-Internal-Api-Key';

/**
 * @function sameSecret
 * @description Constant-time comparison. Both sides are hashed first, so neither the content nor the length of the key leaks through timing.
 */
export function sameSecret(given: string, expected: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * @class InternalApiKeyGuard
 * @description Protects `/internal/*` and `/reconciliation/run`. Off when `INTERNAL_API_KEY` is empty, so the demo and compose work without a key; on when set, requiring `X-Internal-Api-Key` to match.
 */
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.config.internalApiKey;
    if (expected === null) return true;
    const given = ctx
      .switchToHttp()
      .getRequest<Request>()
      .header(INTERNAL_API_KEY_HEADER);
    if (given === undefined || !sameSecret(given, expected)) {
      throw new AppError('UNAUTHORIZED');
    }
    return true;
  }
}

/** Puts a controller or route behind `InternalApiKeyGuard`. */
export const InternalOnly = (): ClassDecorator & MethodDecorator =>
  UseGuards(InternalApiKeyGuard);

/**
 * @class InternalApiKeyNotice
 * @description Warns once at boot when the guard is off, so an open internal API is never a surprise in the logs.
 */
@Injectable()
export class InternalApiKeyNotice implements OnApplicationBootstrap {
  private readonly logger = new Logger('InternalApiKeyGuard');

  constructor(private readonly config: AppConfig) {}

  onApplicationBootstrap(): void {
    if (this.config.internalApiKey === null) {
      this.logger.warn(
        'INTERNAL_API_KEY is not set: /internal/* and /reconciliation/run are open to anyone who can reach the API (A4)',
      );
    }
  }
}
