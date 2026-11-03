import { loadConfig } from './app-config';
import { TEST_ENV } from './testing';

describe('loadConfig', () => {
  it('applies defaults and converts toman to rial', () => {
    const c = loadConfig(TEST_ENV);
    expect(c.role).toBe('api');
    expect(c.http.port).toBe(3000);
    expect(c.limits.withdrawMinRial).toBe(1_000_000n);
    expect(c.limits.withdrawDailyLimitRial).toBe(2_000_000_000n);
    expect(c.internalApiKey).toBeNull();
  });

  it('turns the internal guard on when a key is set', () => {
    expect(
      loadConfig({ ...TEST_ENV, INTERNAL_API_KEY: 'k' }).internalApiKey,
    ).toBe('k');
  });

  it.each(['api', 'worker', 'all'] as const)('accepts APP_ROLE=%s', (role) => {
    expect(loadConfig({ ...TEST_ENV, APP_ROLE: role }).role).toBe(role);
  });

  it('rejects an unknown APP_ROLE', () => {
    expect(() => loadConfig({ ...TEST_ENV, APP_ROLE: 'admin' })).toThrow(
      /APP_ROLE/,
    );
  });

  it('fails fast on a missing variable', () => {
    const { DATABASE_URL: _omit, ...rest } = TEST_ENV;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects decimal money', () => {
    expect(() =>
      loadConfig({ ...TEST_ENV, WITHDRAW_MIN_TOMAN: '100000.5' }),
    ).toThrow(/WITHDRAW_MIN_TOMAN/);
  });
});
