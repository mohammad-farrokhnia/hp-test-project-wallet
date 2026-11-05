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
    expect(c.idempotency).toEqual({
      retentionDays: 7,
      cleanupIntervalMinutes: 60,
    });
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
    const { PSP_BASE_URL: _omit, ...rest } = TEST_ENV;
    expect(() => loadConfig(rest)).toThrow(/PSP_BASE_URL/);
  });

  it('builds the database url from the POSTGRES_* parts', () => {
    expect(loadConfig(TEST_ENV).db.url).toBe(
      'postgres://wallet:wallet@localhost:5432/wallet',
    );
    const c = loadConfig({
      ...TEST_ENV,
      POSTGRES_HOST: 'db',
      POSTGRES_PORT: '55432',
      POSTGRES_USER: 'u',
      POSTGRES_PASSWORD: 'p@ss/word',
      POSTGRES_DB: 'w',
    });
    expect(c.db.url).toBe('postgres://u:p%40ss%2Fword@db:55432/w');
  });

  it.each(['0', '70000', 'abc'])('rejects POSTGRES_PORT=%s', (port) => {
    expect(() => loadConfig({ ...TEST_ENV, POSTGRES_PORT: port })).toThrow(
      /POSTGRES_PORT/,
    );
  });

  it('builds the RabbitMQ url from the RABBITMQ_* parts', () => {
    expect(loadConfig(TEST_ENV).rabbit).toEqual({
      url: 'amqp://guest:guest@localhost:5672',
      publishTimeoutMs: 5000,
      publishRetries: 3,
    });
    const c = loadConfig({
      ...TEST_ENV,
      RABBITMQ_HOST: 'mq',
      RABBITMQ_PORT: '55672',
      RABBITMQ_USER: 'u',
      RABBITMQ_PASSWORD: 'p@ss',
      RABBITMQ_PUBLISH_RETRIES: '0',
    });
    expect(c.rabbit.url).toBe('amqp://u:p%40ss@mq:55672');
    expect(c.rabbit.publishRetries).toBe(0);
  });

  it('rejects decimal money', () => {
    expect(() =>
      loadConfig({ ...TEST_ENV, WITHDRAW_MIN_TOMAN: '100000.5' }),
    ).toThrow(/WITHDRAW_MIN_TOMAN/);
  });
});
