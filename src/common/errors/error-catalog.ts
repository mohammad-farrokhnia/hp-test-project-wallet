export const ERROR_CATALOG = {
  VALIDATION_ERROR: { status: 400, message: 'Invalid request' },
  IDEMPOTENCY_KEY_REQUIRED: {
    status: 400,
    message: 'Idempotency-Key header is required',
  },
  INVALID_DESTINATION: { status: 400, message: 'Invalid destination' },
  INVALID_CURSOR: { status: 400, message: 'Invalid cursor' },
  UNAUTHORIZED: { status: 401, message: 'Unauthorized' },
  INVALID_SIGNATURE: { status: 401, message: 'Invalid signature' },
  NOT_FOUND: { status: 404, message: 'Not found' },
  IDEMPOTENCY_IN_PROGRESS: {
    status: 409,
    message: 'A request with this key is still in progress',
  },
  CANCEL_NOT_ALLOWED: { status: 409, message: 'Cancel is not allowed' },
  BELOW_MINIMUM: { status: 422, message: 'Amount is below the minimum' },
  INSUFFICIENT_FUNDS: { status: 422, message: 'Insufficient funds' },
  DAILY_LIMIT_EXCEEDED: { status: 422, message: 'Daily limit exceeded' },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    message: 'Idempotency key was used with a different request',
  },
  SAME_USER: { status: 422, message: 'Cannot transfer to the same user' },
  INTERNAL_ERROR: { status: 500, message: 'Internal server error' },
  SERVICE_BUSY: { status: 503, message: 'Service is busy, retry shortly' },
  NOT_READY: { status: 503, message: 'Service is not ready' },
  PROVIDER_UNAVAILABLE: {
    status: 503,
    message: 'Provider unavailable, retry with the same key',
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface ErrorBody {
  code: ErrorCode;
  message: string;
}
