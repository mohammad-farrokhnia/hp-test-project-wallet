import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { AppError } from '../errors/app-error';

const MAX_MESSAGES = 5;

export const MAX_BODY_DEPTH = 8;

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
 * @function exceedsDepth
 * @description Whether a parsed JSON value nests deeper than `max` levels. Iterative on purpose: Nest's own pipe walks the body recursively
 * and a body of a few thousand nested brackets overflows its stack.
 * @param value - a parsed JSON value
 * @param max - the deepest nesting allowed
 * @returns true when it is deeper
 */
export function exceedsDepth(value: unknown, max: number): boolean {
  const pending: [unknown, number][] = [[value, 0]];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [node, depth] = next;
    if (typeof node !== 'object' || node === null) continue;
    if (depth >= max) return true;
    for (const child of Object.values(node)) pending.push([child, depth + 1]);
  }
  return false;
}

/** Strict DTO validation that refuses an over-nested body before the recursive checks run. */
class BoundedValidationPipe extends ValidationPipe {
  override transform(
    value: unknown,
    metadata: ArgumentMetadata,
  ): Promise<unknown> {
    if (metadata.type === 'body' && exceedsDepth(value, MAX_BODY_DEPTH)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Request body is nested too deeply',
      );
    }
    return super.transform(value, metadata);
  }
}

/**
 * @function createValidationPipe
 * @description Strict DTO validation: unknown properties are rejected, types are never coerced, and failures surface as `VALIDATION_ERROR`.
 * @returns the pipe to register globally
 */
export function createValidationPipe(): ValidationPipe {
  return new BoundedValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new AppError('VALIDATION_ERROR', formatValidationErrors(errors)),
  });
}
