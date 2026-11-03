import { QueryFailedError } from 'typeorm';
import { AppError } from './app-error';

const LOCK_NOT_AVAILABLE = '55P03';
const DEADLOCK_DETECTED = '40P01';
const SERIALIZATION_FAILURE = '40001';
const QUERY_CANCELED = '57014';

const BUSY = new Set([
  LOCK_NOT_AVAILABLE,
  DEADLOCK_DETECTED,
  SERIALIZATION_FAILURE,
  QUERY_CANCELED,
]);

/**
 * @function mapDatabaseError
 * @description Maps database contention errors to `SERVICE_BUSY`. Constraint violations are not mapped: repositories translate those into domain errors.
 * @param err - any thrown value
 * @returns an `AppError`, or `undefined` if the error is not a contention error
 */
export function mapDatabaseError(err: unknown): AppError | undefined {
  if (!(err instanceof QueryFailedError)) return undefined;
  const code = (err.driverError as { code?: string } | undefined)?.code;
  return code && BUSY.has(code) ? new AppError('SERVICE_BUSY') : undefined;
}
