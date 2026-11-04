/**
 * Regenerates src/database/db.types.ts (the Kysely table types) from the live schema.
 *
 *   npm run db:types
 *
 * Reads POSTGRES_* from .env (same defaults as the app), applies pending migrations so
 * the types match the migrations in the repo, then runs kysely-codegen. Needs Postgres up:
 * `docker compose up -d --wait postgres`. Commit the generated file.
 */
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');

if (existsSync('.env')) process.loadEnvFile('.env');
const env = process.env;

const url =
  `postgres://${encodeURIComponent(env.POSTGRES_USER || 'wallet')}` +
  `:${encodeURIComponent(env.POSTGRES_PASSWORD || 'wallet')}` +
  `@${env.POSTGRES_HOST || 'localhost'}:${env.POSTGRES_PORT || 5432}` +
  `/${encodeURIComponent(env.POSTGRES_DB || 'wallet')}`;

function run(cmd, args, extraEnv = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...env, ...extraEnv },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run('npx', ['ts-node', 'src/migrate.ts']);
run(
  'npx',
  [
    'kysely-codegen',
    '--dialect=postgres',
    '--url=env(CODEGEN_DATABASE_URL)',
    '--exclude-pattern=public.migrations',
    '--out-file=src/database/db.types.ts',
  ],
  { CODEGEN_DATABASE_URL: url },
);
run('npx', ['prettier', '--write', 'src/database/db.types.ts']);
