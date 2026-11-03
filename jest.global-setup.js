// Runs once before all tests: make sure the *_test database exists, so nobody has to
// create it by hand and dev data is never involved. Needs a role allowed to CREATE DATABASE
// (the compose Postgres user is a superuser).
const { Client } = require('pg');
const loadTestEnv = require('./jest.load-env');

module.exports = async function globalSetup() {
  const env = loadTestEnv(process.env);
  if (!env.DATABASE_URL) return;

  const target = new URL(env.DATABASE_URL);
  const dbName = decodeURIComponent(target.pathname.slice(1)); // validated as *_test
  const admin = new URL(target);
  admin.pathname = '/postgres';

  const client = new Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch {
    // Unit tests don't need a database; the integration suite will fail on its own.
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
        if (err.code !== '42P04') throw err; // already created by a parallel run
      }
    }
  } finally {
    await client.end();
  }
};
