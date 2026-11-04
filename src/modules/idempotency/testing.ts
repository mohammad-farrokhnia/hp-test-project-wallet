import { IdempotencyService } from './idempotency.service';
import { IdempotencyKeysRepository } from './repositories/idempotency-keys.repository';

/**
 * @function newIdempotencyService
 * @description An `IdempotencyService` wired with its real repository, for tests that run without Nest.
 * @returns the service
 */
export function newIdempotencyService(): IdempotencyService {
  return new IdempotencyService(new IdempotencyKeysRepository());
}
