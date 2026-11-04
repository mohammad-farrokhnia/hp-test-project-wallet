export interface PostgresParts {
  host: string;
  port: number | string;
  user: string;
  password: string;
  database: string;
}

/**
 * @function buildDatabaseUrl
 * @description Assembles a `postgres://` connection string from its parts, percent-encoding the credentials.
 * @param p - host, port, user, password and database name
 * @returns the connection string
 */
export function buildDatabaseUrl(p: PostgresParts): string {
  const user = encodeURIComponent(p.user);
  const password = encodeURIComponent(p.password);
  const database = encodeURIComponent(p.database);
  return `postgres://${user}:${password}@${p.host}:${p.port}/${database}`;
}

/**
 * @function databaseUrlFromEnv
 * @description Builds the connection string from `POSTGRES_*` variables with the same defaults as the app config, but only when `POSTGRES_DB` is set. Lets integration specs skip when no database is configured.
 * @param env - the environment to read
 * @returns the connection string, or `undefined` when `POSTGRES_DB` is unset
 */
export function databaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!env.POSTGRES_DB) return undefined;
  return buildDatabaseUrl({
    host: env.POSTGRES_HOST || 'localhost',
    port: env.POSTGRES_PORT || 5432,
    user: env.POSTGRES_USER || 'wallet',
    password: env.POSTGRES_PASSWORD || 'wallet',
    database: env.POSTGRES_DB,
  });
}
