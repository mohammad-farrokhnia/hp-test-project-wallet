import { AppError } from './app-error';
import { ERROR_CATALOG, ErrorCode } from './error-catalog';

const codes = Object.keys(ERROR_CATALOG) as ErrorCode[];

describe('error catalog', () => {
  it.each([
    ['VALIDATION_ERROR', 400],
    ['IDEMPOTENCY_KEY_REQUIRED', 400],
    ['INVALID_DESTINATION', 400],
    ['INVALID_CURSOR', 400],
    ['UNAUTHORIZED', 401],
    ['INVALID_SIGNATURE', 401],
    ['NOT_FOUND', 404],
    ['IDEMPOTENCY_IN_PROGRESS', 409],
    ['CANCEL_NOT_ALLOWED', 409],
    ['BELOW_MINIMUM', 422],
    ['INSUFFICIENT_FUNDS', 422],
    ['DAILY_LIMIT_EXCEEDED', 422],
    ['IDEMPOTENCY_KEY_REUSED', 422],
    ['SAME_USER', 422],
    ['INTERNAL_ERROR', 500],
    ['SERVICE_BUSY', 503],
    ['NOT_READY', 503],
    ['PROVIDER_UNAVAILABLE', 503],
  ] as const)('%s maps to HTTP %s', (code, status) => {
    expect(ERROR_CATALOG[code].status).toBe(status);
  });

  it('holds exactly the 18 documented codes', () => {
    expect(codes).toHaveLength(18);
  });

  it.each(codes)('%s has a non-empty client message', (code) => {
    expect(ERROR_CATALOG[code].message.length).toBeGreaterThan(0);
  });

  it('builds an AppError whose status and body come from the catalog', () => {
    const err = new AppError('BELOW_MINIMUM');
    expect(err.status).toBe(422);
    expect(err.toBody()).toEqual({
      code: 'BELOW_MINIMUM',
      message: ERROR_CATALOG.BELOW_MINIMUM.message,
    });
  });

  it('allows a specific message without changing code or status', () => {
    const err = new AppError('VALIDATION_ERROR', 'amount must be a string');
    expect(err.toBody()).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'amount must be a string',
    });
    expect(err.status).toBe(400);
  });
});
