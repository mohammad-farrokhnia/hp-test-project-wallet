const { Client } = require('pg');
const loadTestEnv = require('./jest.load-env');

/**
 * @function globalSetup
 * @description Creates the `_test` database named by `DATABASE_URL` if it does not exist.
 */
module.exports = async function globalSetup() {
  const env = loadTestEnv(process.env);
  if (!env.DATABASE_URL) return;

  const target = new URL(env.DATABASE_URL);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  const admin = new URL(target);
  admin.pathname = '/postgres';

  const client = new Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch {
    process.stderr.write(
      `\nPostgres is not reachable at ${admin.host}: database tests will fail ` +
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
