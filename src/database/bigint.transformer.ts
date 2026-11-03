import { ValueTransformer } from 'typeorm';

/**
 * @function bigintTransformer.to
 * @function bigintTransformer.from
 * @description transforms bigint values to strings for storage in the database and back to bigint when retrieved.
 */
export const bigintTransformer: ValueTransformer = {
  to(value: bigint | null | undefined): string | null | undefined {
    return value === null || value === undefined ? value : value.toString();
  },
  from(value: string | bigint | null | undefined): bigint | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return value;
    if (typeof value !== 'string') {
      throw new TypeError(
        `BIGINT column returned ${typeof value}; refusing to risk precision loss`,
      );
    }
    return BigInt(value);
  },
};
