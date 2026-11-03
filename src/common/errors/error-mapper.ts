import { HttpException } from '@nestjs/common';
import { MoneyError } from '../money';
import { AppError } from './app-error';
import { mapDatabaseError } from './db-error.mapper';

interface ParserError {
  status?: number;
  statusCode?: number;
  type?: string;
  message?: string;
}

function parserStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, statusCode, type } = err as ParserError;
  const value = status ?? statusCode;
  return typeof type === 'string' && typeof value === 'number'
    ? value
    : undefined;
}

function httpExceptionMessage(err: HttpException): string | undefined {
  const response = err.getResponse();
  if (typeof response === 'string') return response;
  const { message } = response as { message?: unknown };
  if (Array.isArray(message)) return message.join('; ');
  return typeof message === 'string' ? message : undefined;
}

/**
 * @function toAppError
 * @description Converts any thrown value into the catalog error the client sees. Unknown errors become `INTERNAL_ERROR` with no detail.
 * @param err - any thrown value
 * @returns an `AppError`
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof MoneyError) {
    return err.code === 'INVALID_AMOUNT' || err.code === 'UNKNOWN_CURRENCY'
      ? new AppError('VALIDATION_ERROR', err.message)
      : new AppError('INTERNAL_ERROR');
  }

  const dbError = mapDatabaseError(err);
  if (dbError) return dbError;

  if (err instanceof HttpException) {
    const status = err.getStatus();
    if (status === 404)
      return new AppError('NOT_FOUND', httpExceptionMessage(err));
    if (status === 401) return new AppError('UNAUTHORIZED');
    if (status >= 400 && status < 500) {
      return new AppError('VALIDATION_ERROR', httpExceptionMessage(err));
    }
    return new AppError('INTERNAL_ERROR');
  }

  const status = parserStatus(err);
  if (status !== undefined && status >= 400 && status < 500) {
    return new AppError('VALIDATION_ERROR');
  }

  return new AppError('INTERNAL_ERROR');
}
