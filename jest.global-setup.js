const { Client } = require('pg');
const loadTestEnv = require('./jest.load-env');

/**
 * @function globalSetup
 * @description Creates the `_test` database named by `POSTGRES_DB` if it does not exist.
 */
module.exports = async function globalSetup() {
  const env = loadTestEnv(process.env);
  if (!env.POSTGRES_DB) return;

  const dbName = env.POSTGRES_DB;
  const admin = {
    host: env.POSTGRES_HOST || 'localhost',
    port: Number(env.POSTGRES_PORT || 5432),
    user: env.POSTGRES_USER || 'wallet',
    password: env.POSTGRES_PASSWORD || 'wallet',
    database: 'postgres',
  };

  const client = new Client(admin);
  try {
    await client.connect();
  } catch {
    process.stderr.write(
      `\nPostgres is not reachable at ${admin.host}:${admin.port}: database tests will fail ` +
        '(start it with `docker compose up -d --wait postgres`).\n',
    );
    return;
  }
  try {
    const exists = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName],
    );
    if (exists.rowCount === 0) {
      try {
        await client.query(`CREATE DATABASE "${dbName}"`);
      } catch (err) {
        if (err.code !== '42P04') throw err;
      }
    }
  } finally {
    await client.end();
  }
};
