const PERSIAN_CALENDAR = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'UTC',
});

/**
 * @function isCalendarDay
 * @param day - text to check
 * @returns true when it is a real Gregorian day written `YYYY-MM-DD` (2026-02-30 and 2026-13-45 are not)
 */
export function isCalendarDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const at = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === day;
}

/**
 * @function jalaliDate
 * @description The Persian (Jalali) calendar date of a Gregorian day, as the PSP's settlement file writes it, with Latin digits: `2026-11-06` is `1405/08/15`.
 * Uses the runtime's ICU calendar, so there is no hand-written conversion to get wrong around leap years.
 * @param day - a real Gregorian day, `YYYY-MM-DD`
 * @returns `YYYY/MM/DD`
 * @throws {Error} when `day` is not a real calendar day
 */
export function jalaliDate(day: string): string {
  if (!isCalendarDay(day)) throw new Error(`not a calendar day: ${day}`);
  const parts = PERSIAN_CALENDAR.formatToParts(new Date(`${day}T12:00:00Z`));
  const part = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}/${part('month')}/${part('day')}`;
}
