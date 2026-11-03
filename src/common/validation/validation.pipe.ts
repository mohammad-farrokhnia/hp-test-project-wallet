import { ValidationPipe } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { AppError } from '../errors/app-error';

const MAX_MESSAGES = 5;

function collect(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => {
    const path = prefix + e.property;
    const own = Object.values(e.constraints ?? {});
    return own.length > 0 ? own : collect(e.children ?? [], `${path}.`);
  });
}

/**
 * @function formatValidationErrors
 * @description Flattens class-validator errors, including nested ones, into one client-safe message.
 * @param errors - the validation errors
 * @returns up to five messages joined with `; `
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  const messages = collect(errors);
  if (messages.length === 0) return 'Invalid request';
  const shown = messages.slice(0, MAX_MESSAGES).join('; ');
  return messages.length > MAX_MESSAGES ? `${shown}; …` : shown;
}

/**
 * @function createValidationPipe
 * @description Strict DTO validation: unknown properties are rejected, types are never coerced, and failures surface as `VALIDATION_ERROR`.
 * @returns the pipe to register globally
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new AppError('VALIDATION_ERROR', formatValidationErrors(errors)),
  });
}
