import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { loadConfig } from './app-config';
import { envSchema } from './env.schema';

/** Settings only docker-compose reads: the app ignores them. */
const COMPOSE_ONLY = [
  'APP_BIND',
  'APP_PORT',
  'SIM_CHAOS',
  'SIM_TIME_SCALE',
  'RABBITMQ_UI_PORT',
  'SIMULATOR_PORT',
];

describe('.env.example', () => {
  const example = parseEnv(readFileSync('.env.example', 'utf8'));
  const schemaKeys = Object.keys(envSchema.shape);
  const value = (key: string): string => example[key] ?? '';

  it('lists every setting the app reads, so a copy of it is a complete configuration', () => {
    expect(schemaKeys.filter((k) => !(k in example))).toEqual([]);
  });

  it('lists nothing the app and compose both ignore', () => {
    const known = new Set([...schemaKeys, ...COMPOSE_ONLY]);
    expect(Object.keys(example).filter((k) => !known.has(k))).toEqual([]);
  });

  it('is accepted by the validated config as it stands', () => {
    expect(() => loadConfig(example)).not.toThrow();
  });

  it('publishes the simulator on the port the PSP and payout URLs point at', () => {
    const port = (url: string) => new URL(url).port;
    expect(value('SIMULATOR_PORT')).toBe(port(value('PSP_BASE_URL')));
    expect(value('SIMULATOR_PORT')).toBe(port(value('PAYOUT_BASE_URL')));
  });

  it('publishes Postgres and RabbitMQ on the ports the app is told to connect to, by default', () => {
    expect(parseInt(value('POSTGRES_PORT'), 10)).toBeGreaterThan(0);
    expect(parseInt(value('RABBITMQ_PORT'), 10)).toBeGreaterThan(0);
  });
});
