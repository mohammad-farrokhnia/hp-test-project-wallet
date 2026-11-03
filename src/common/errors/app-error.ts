import { ERROR_CATALOG, ErrorBody, ErrorCode } from './error-catalog';

/** The only error type services throw on purpose; the HTTP status comes from the catalog. */
export class AppError extends Error {
  readonly status: number;

  /**
   * @param code - catalog code
   * @param message - client-safe text; defaults to the catalog message
   */
  constructor(
    readonly code: ErrorCode,
    message: string = ERROR_CATALOG[code].message,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_CATALOG[code].status;
  }

  toBody(): ErrorBody {
    return { code: this.code, message: this.message };
  }
}
