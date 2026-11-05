import { IsString } from 'class-validator';
import { AppError } from '../errors/app-error';
import {
  createValidationPipe,
  exceedsDepth,
  MAX_BODY_DEPTH,
} from './validation.pipe';

class Dto {
  @IsString()
  name!: string;
}

const nested = (levels: number, leaf: unknown = 'x'): unknown => {
  let value = leaf;
  for (let i = 0; i < levels; i++) value = [value];
  return value;
};
const body = { type: 'body', metatype: Dto } as const;

describe('exceedsDepth', () => {
  it('lets flat and shallow values through', () => {
    expect(exceedsDepth({ a: 1, b: 'x', c: null }, MAX_BODY_DEPTH)).toBe(false);
    expect(exceedsDepth({ a: { b: { c: 1 } } }, MAX_BODY_DEPTH)).toBe(false);
    expect(exceedsDepth('text', MAX_BODY_DEPTH)).toBe(false);
  });

  it('counts arrays and objects alike, exactly at the limit', () => {
    expect(exceedsDepth(nested(MAX_BODY_DEPTH), MAX_BODY_DEPTH)).toBe(false);
    expect(exceedsDepth(nested(MAX_BODY_DEPTH + 1), MAX_BODY_DEPTH)).toBe(true);
    expect(exceedsDepth({ a: { b: [{ c: [1] }] } }, 3)).toBe(true);
  });

  it('survives a nesting that overflows the stack of a recursive walk', () => {
    expect(exceedsDepth(nested(200_000), MAX_BODY_DEPTH)).toBe(true);
  });
});

describe('the global validation pipe', () => {
  const pipe = createValidationPipe();

  it('answers VALIDATION_ERROR, not a stack overflow, for an over-nested body', () => {
    expect(() => pipe.transform(nested(5000), body)).toThrow(AppError);
    expect(() => pipe.transform(nested(5000), body)).toThrow(
      'nested too deeply',
    );
  });

  it('still validates an ordinary body', async () => {
    await expect(pipe.transform({ name: 'ok' }, body)).resolves.toBeInstanceOf(
      Dto,
    );
    await expect(pipe.transform({ name: 5 }, body)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      pipe.transform({ name: 'ok', extra: 1 }, body),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
