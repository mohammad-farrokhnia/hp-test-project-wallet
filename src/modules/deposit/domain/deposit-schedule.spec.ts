import { pollDelaySeconds } from './deposit-schedule';

const MIN = 60;

describe('pollDelaySeconds (ADR-11 poll schedule)', () => {
  it.each([
    [0, 0, 15],
    [1, 15, 15],
    [2, 30, 30],
  ])('check %i is followed by %i s', (attempts, age, expected) => {
    expect(pollDelaySeconds(attempts, age)).toBe(expected);
  });

  it('polls every minute until 30 minutes after creation', () => {
    expect(pollDelaySeconds(3, 60)).toBe(MIN);
    expect(pollDelaySeconds(40, 30 * MIN - 1)).toBe(MIN);
  });

  it('polls every 5 minutes from 30 minutes on', () => {
    expect(pollDelaySeconds(40, 30 * MIN)).toBe(5 * MIN);
    expect(pollDelaySeconds(400, 23 * 60 * MIN)).toBe(5 * MIN);
  });

  it('keeps the first three delays whatever the age (a deposit first checked late)', () => {
    expect(pollDelaySeconds(0, 2 * 60 * MIN)).toBe(15);
  });
});
