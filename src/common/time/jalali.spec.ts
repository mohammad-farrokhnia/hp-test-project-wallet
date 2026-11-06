import { isCalendarDay, jalaliDate } from './jalali';

describe('jalaliDate', () => {
  it.each([
    ['2026-11-06', '1405/08/15'],
    ['2026-11-05', '1405/08/14'],
    ['2026-11-04', '1405/08/13'],
    ['2026-11-01', '1405/08/10'],
    ['2020-01-01', '1398/10/11'],
  ])(
    '%s is %s, the date the simulator writes in its settlement file',
    (day, expected) => {
      expect(jalaliDate(day)).toBe(expected);
    },
  );

  it.each([
    ['2026-03-20', '1404/12/29'],
    ['2026-03-21', '1405/01/01'],
    ['2027-03-21', '1406/01/01'],
    ['2026-09-22', '1405/06/31'],
    ['2026-09-23', '1405/07/01'],
  ])('%s is %s: year, month and leap boundaries', (day, expected) => {
    expect(jalaliDate(day)).toBe(expected);
  });

  it('refuses what is not a day', () => {
    expect(() => jalaliDate('2026-13-45')).toThrow('not a calendar day');
    expect(() => jalaliDate('abc')).toThrow('not a calendar day');
  });
});

describe('isCalendarDay', () => {
  it.each(['2026-11-06', '2024-02-29', '2000-01-01'])('accepts %s', (d) => {
    expect(isCalendarDay(d)).toBe(true);
  });

  it.each([
    '',
    'abc',
    '2026-13-45',
    '2026-02-30',
    '2025-02-29',
    '2026-1-5',
    '26-11-06',
    '2026/11/06',
    ' 2026-11-06',
    '2026-11-06T00:00:00Z',
  ])('refuses %j', (d) => {
    expect(isCalendarDay(d)).toBe(false);
  });
});
