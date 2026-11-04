import { uuidv7 } from './uuidv7';

describe('uuidv7', () => {
  it('is a canonical version 7, variant 10 UUID', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('starts with the timestamp in milliseconds', () => {
    const id = uuidv7(0x0193_4e5f_a1b2);
    expect(id.startsWith('01934e5f-a1b2-7')).toBe(true);
  });

  it('sorts by creation time', () => {
    const ids = [3, 1, 2].map((t) => uuidv7(1_700_000_000_000 + t));
    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]]);
  });

  it('is unique within the same millisecond', () => {
    const ids = new Set(
      Array.from({ length: 1000 }, () => uuidv7(1_700_000_000_000)),
    );
    expect(ids.size).toBe(1000);
  });
});
