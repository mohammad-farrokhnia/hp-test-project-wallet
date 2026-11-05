import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { tehranDay } from '../../../common/time';
import { connectTestDb, describeDb } from '../../../database/int-testing';
import { TransactionRunner } from '../../../database/transaction-runner';
import { DailyLimitRepository } from './daily-limit.repository';

const toman = (n: bigint) => n * 10n;
const CAP = toman(200_000_000n); // 200,000,000 toman a day

/** 23:59:59 Tehran is 20:29:59Z, midnight is 20:30:00Z. */
const at = (utc: string) => new Date(utc);

describeDb('Tehran day and the daily limit (real PostgreSQL)', () => {
  let ds: DataSource;
  let runner: TransactionRunner;
  const limits = new DailyLimitRepository();
  const newUser = () => `x2_${randomUUID().slice(0, 12)}`;

  beforeAll(async () => {
    ds = await connectTestDb();
    runner = new TransactionRunner(ds, {
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 20_000,
    });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const dayAt = (instant: Date) => runner.run((tx) => tehranDay(tx, instant));

  describe('tehranDay: the calendar day by the database clock', () => {
    it.each([
      [
        'winter',
        '2026-01-15T20:29:59Z',
        '2026-01-15',
        '2026-01-15T20:30:00Z',
        '2026-01-16',
      ],
      [
        'summer (no daylight saving since 2022)',
        '2026-06-21T20:29:59Z',
        '2026-06-21',
        '2026-06-21T20:30:00Z',
        '2026-06-22',
      ],
      [
        'new year',
        '2026-12-31T20:29:59Z',
        '2026-12-31',
        '2026-12-31T20:30:00Z',
        '2027-01-01',
      ],
    ])(
      '%s: 23:59:59 is still the day, 00:00:00 is the next',
      async (_s, before, day, after, next) => {
        expect(await dayAt(at(before))).toBe(day);
        expect(await dayAt(at(after))).toBe(next);
      },
    );

    it('defaults to the database now(), not this process clock', async () => {
      const [{ day }] = await ds.query<{ day: string }[]>(
        `SELECT to_char(now() AT TIME ZONE 'Asia/Tehran', 'YYYY-MM-DD') AS day`,
      );
      expect(await runner.run((tx) => tehranDay(tx))).toBe(day);
    });

    it('reads DATE columns back as the same calendar day, never shifted by a timezone', async () => {
      const [{ d }] = await ds.query<{ d: unknown }[]>(
        `SELECT '2026-11-04'::date AS d`,
      );
      expect(d).toBe('2026-11-04');
    });
  });

  describe('the daily limit across the Tehran midnight', () => {
    const reserve = (userId: string, day: string, amountRial: bigint) =>
      runner.run((tx) =>
        limits.reserve(tx, { userId, day, amountRial, capRial: CAP }),
      );

    it('23:59 counts toward today; 00:00 starts a fresh limit', async () => {
      const userId = newUser();
      const today = await dayAt(at('2026-11-04T20:29:00Z')); // 23:59 Tehran, Nov 4
      const tomorrow = await dayAt(at('2026-11-04T20:30:00Z')); // 00:00 Tehran, Nov 5
      expect([today, tomorrow]).toEqual(['2026-11-04', '2026-11-05']);

      expect(await reserve(userId, today, toman(150_000_000n))).toBe(true);
      expect(await reserve(userId, today, toman(60_000_000n))).toBe(false);
      expect(await reserve(userId, tomorrow, toman(60_000_000n))).toBe(true);

      const usage = (day: string) =>
        runner.run((tx) => limits.usage(tx, userId, day));
      expect(await usage(today)).toEqual({
        usedRial: toman(150_000_000n),
        capRial: CAP,
      });
      expect(await usage(tomorrow)).toEqual({
        usedRial: toman(60_000_000n),
        capRial: CAP,
      });
    });

    it('allows exactly the cap, and not one rial more', async () => {
      const userId = newUser();
      expect(await reserve(userId, '2026-11-04', CAP - 1n)).toBe(true);
      expect(await reserve(userId, '2026-11-04', 1n)).toBe(true);
      expect(await reserve(userId, '2026-11-04', 1n)).toBe(false);
    });

    it('20 concurrent reservations of 15M toman: exactly 13 fit under 200M', async () => {
      const userId = newUser();
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          reserve(userId, '2026-11-04', toman(15_000_000n)),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(13);
      const usage = await runner.run((tx) =>
        limits.usage(tx, userId, '2026-11-04'),
      );
      expect(usage?.usedRial).toBe(toman(195_000_000n));
    });

    it('release gives the amount back to the day it was reserved on', async () => {
      const userId = newUser();
      await reserve(userId, '2026-11-04', toman(200_000_000n));
      expect(await reserve(userId, '2026-11-04', toman(1n))).toBe(false);
      await runner.run((tx) =>
        limits.release(tx, {
          userId,
          day: '2026-11-04',
          amountRial: toman(50_000_000n),
        }),
      );
      expect(await reserve(userId, '2026-11-04', toman(50_000_000n))).toBe(
        true,
      );
    });

    it('refuses to release more than was reserved, or for a day with no usage', async () => {
      const userId = newUser();
      await reserve(userId, '2026-11-04', 10n);
      await expect(
        runner.run((tx) =>
          limits.release(tx, { userId, day: '2026-11-04', amountRial: 11n }),
        ),
      ).rejects.toMatchObject({ driverError: { code: '23514' } });
      await expect(
        runner.run((tx) =>
          limits.release(tx, { userId, day: '2026-11-05', amountRial: 1n }),
        ),
      ).rejects.toThrow(/no daily usage/);
    });

    it('keeps the cap a day started with, even if the config changes later', async () => {
      const userId = newUser();
      await reserve(userId, '2026-11-04', 1n);
      await runner.run((tx) =>
        limits.reserve(tx, {
          userId,
          day: '2026-11-04',
          amountRial: 1n,
          capRial: CAP * 2n,
        }),
      );
      const usage = await runner.run((tx) =>
        limits.usage(tx, userId, '2026-11-04'),
      );
      expect(usage).toEqual({ usedRial: 2n, capRial: CAP });
    });
  });
});
