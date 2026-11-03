import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { MoneyError } from '../money';
import { AppError } from './app-error';
import { ErrorCode } from './error-catalog';
import { toAppError } from './error-mapper';

const dbError = (code: string) =>
  new QueryFailedError(
    'SELECT secret FROM t',
    [],
    Object.assign(new Error('relation "t" leaks'), { code }),
  );

const parserError = (type: string, status: number) =>
  Object.assign(new Error('Unexpected token } in JSON'), { type, status });

describe('toAppError', () => {
  it.each<[string, unknown, ErrorCode, number]>([
    ['an AppError passes through', new AppError('SAME_USER'), 'SAME_USER', 422],
    ['unknown route', new NotFoundException('Cannot GET /x'), 'NOT_FOUND', 404],
    ['unauthorized', new UnauthorizedException(), 'UNAUTHORIZED', 401],
    [
      'other 4xx HttpException',
      new ForbiddenException(),
      'VALIDATION_ERROR',
      400,
    ],
    [
      'plain bad request',
      new BadRequestException('nope'),
      'VALIDATION_ERROR',
      400,
    ],
    [
      '5xx HttpException',
      new InternalServerErrorException('db down'),
      'INTERNAL_ERROR',
      500,
    ],
    ['teapot', new HttpException('x', 418), 'VALIDATION_ERROR', 400],
    [
      'malformed JSON body',
      parserError('entity.parse.failed', 400),
      'VALIDATION_ERROR',
      400,
    ],
    [
      'oversized body',
      parserError('entity.too.large', 413),
      'VALIDATION_ERROR',
      400,
    ],
    [
      'MoneyError INVALID_AMOUNT',
      new MoneyError('INVALID_AMOUNT', 'bad'),
      'VALIDATION_ERROR',
      400,
    ],
    [
      'MoneyError UNKNOWN_CURRENCY',
      new MoneyError('UNKNOWN_CURRENCY', 'bad'),
      'VALIDATION_ERROR',
      400,
    ],
    [
      'MoneyError OUT_OF_RANGE (a bug)',
      new MoneyError('OUT_OF_RANGE', 'x'),
      'INTERNAL_ERROR',
      500,
    ],
    [
      'MoneyError CURRENCY_MISMATCH (a bug)',
      new MoneyError('CURRENCY_MISMATCH', 'x'),
      'INTERNAL_ERROR',
      500,
    ],
    ['lock timeout', dbError('55P03'), 'SERVICE_BUSY', 503],
    ['deadlock after retries', dbError('40P01'), 'SERVICE_BUSY', 503],
    ['serialization failure', dbError('40001'), 'SERVICE_BUSY', 503],
    ['statement timeout', dbError('57014'), 'SERVICE_BUSY', 503],
    ['unique violation', dbError('23505'), 'INTERNAL_ERROR', 500],
    ['check violation', dbError('23514'), 'INTERNAL_ERROR', 500],
    ['a plain Error', new Error('boom'), 'INTERNAL_ERROR', 500],
    ['a thrown string', 'boom', 'INTERNAL_ERROR', 500],
    ['null', null, 'INTERNAL_ERROR', 500],
    ['undefined', undefined, 'INTERNAL_ERROR', 500],
    [
      'an object with a status field',
      { status: 400, message: 'x' },
      'INTERNAL_ERROR',
      500,
    ],
  ])('%s', (_name, input, code, status) => {
    const err = toAppError(input);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });

  it('keeps the HttpException message for a validation error', () => {
    expect(toAppError(new BadRequestException('amount is bad')).message).toBe(
      'amount is bad',
    );
  });

  it('joins an array of messages from an HttpException', () => {
    const err = new BadRequestException({ message: ['a is bad', 'b is bad'] });
    expect(toAppError(err).message).toBe('a is bad; b is bad');
  });

  it.each([
    ['an unexpected Error', new Error('password=hunter2')],
    ['a database error', dbError('23505')],
    [
      'a 5xx HttpException',
      new InternalServerErrorException('stack at /srv/app.js'),
    ],
    [
      'MoneyError OUT_OF_RANGE',
      new MoneyError('OUT_OF_RANGE', '9999 does not fit'),
    ],
  ])('never leaks details of %s', (_name, input) => {
    const { message } = toAppError(input);
    expect(message).not.toMatch(/hunter2|SELECT|relation|stack at|9999/);
  });
});
