const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');

function read(file) {
  try {
    return parseEnv(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

/** Tests TRUNCATE and DROP tables: refuse to run against anything not named *_test. */
function assertTestDatabase(env) {
  if (!env.DATABASE_URL) return;
  const name = decodeURIComponent(new URL(env.DATABASE_URL).pathname.slice(1));
  if (!/^[a-z0-9_]*_test$/.test(name)) {
    throw new Error(
      `Refusing to run tests against database "${name}": the name must end in "_test". ` +
        'Create .env.test with a *_test DATABASE_URL (README, "Running the tests").',
    );
  }
}

/**
 * @function loadTestEnv
 * @description Loads `.env.test` (overriding) then `.env` (filling gaps) into `env`, and rejects a non-`_test` database.
 * @param env - the environment object to populate
 * @returns the same environment object
 */
function loadTestEnv(env) {
  Object.assign(env, read('.env.test'));
  for (const [key, value] of Object.entries(read('.env'))) {
    if (env[key] === undefined) env[key] = value;
  }
  assertTestDatabase(env);
  return env;
}

module.exports = loadTestEnv;
