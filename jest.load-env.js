// Loader for the test environment, used by jest.env.js (setup file, runs in every test
// sandbox) and jest.global-setup.js (runs once, in the real process). It is a separate
// module because Jest calls any function a setup file exports.
//
//   .env.test  (git-ignored, see README) overrides anything already set, even an exported shell DATABASE_URL,
//              so a dev database can't leak into a test run.
//   .env       only fills variables that are still missing.
//
// Jest gives each test file a sandboxed copy of process.env, so process.loadEnvFile()
// (which fills the real one) would have no effect there; parse and assign instead.
// Both files are optional: the compose test service passes its variables in directly.
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

function loadTestEnv(env) {
  Object.assign(env, read('.env.test'));
  for (const [key, value] of Object.entries(read('.env'))) {
    if (env[key] === undefined) env[key] = value;
  }
  assertTestDatabase(env);
  return env;
}

module.exports = loadTestEnv;
