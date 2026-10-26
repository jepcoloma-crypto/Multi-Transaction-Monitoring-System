import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSecrets, MIN_JWT_SECRET_LENGTH } from '../services/configGuard';

// Long enough to satisfy the length rule and still worthless, because it is
// printed in the repository. This is the case a length check alone would wave
// through.
const EXAMPLE_PLACEHOLDER = 'change-me-in-production-use-a-strong-random-secret';
const A_REAL_SECRET = 'x7Qm2Vb9Lp4Rt8Yw1Zn6Hd3Jf5Ks0Ae2Uc9';

// A stand-in for the deployed environment. Both secrets are set to values that
// pass, so each case reports on the one thing it is about — the two checks
// must not need to be read together to be understood.
const prod = (env: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  JWT_SECRET: A_REAL_SECRET,
  DB_PASSWORD: 'a-rotated-local-password',
  ...env,
});

test('production refuses a missing signing secret', async () => {
  const { errors, warnings } = checkSecrets(prod({ JWT_SECRET: '' }));

  assert.equal(errors.length, 1, 'one refusal, not one per check');
  assert.match(errors[0], /JWT_SECRET is not set/);
  assert.equal(warnings.length, 0, 'nothing else to report alongside a refusal');
});

test('production refuses a secret too short to be a secret', async () => {
  const { errors } = checkSecrets(prod({ JWT_SECRET: 'short-one' }));

  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`shorter than ${MIN_JWT_SECRET_LENGTH} characters`));
});

test('production refuses the fallback the config would otherwise use', async () => {
  const { errors } = checkSecrets(prod({ JWT_SECRET: 'dev-jwt-secret' }));

  assert.equal(errors.length, 1, 'long enough, and still refused — it is in the code');
  assert.match(errors[0], /published in this repository/);
});

test('production refuses the example placeholder even though it is long', async () => {
  const { errors } = checkSecrets(prod({ JWT_SECRET: EXAMPLE_PLACEHOLDER }));

  assert.equal(errors.length, 1, `a ${EXAMPLE_PLACEHOLDER.length}-character constant is still a constant`);
  assert.match(errors[0], /published in this repository/);
});

test('production accepts a real secret, ignoring surrounding whitespace', async () => {
  const { errors, warnings } = checkSecrets(prod({ JWT_SECRET: `  ${A_REAL_SECRET}  ` }));

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, [], 'neither check has anything to say');
});

test('an error never echoes the secret it is rejecting', async () => {
  const weak = 'open-sesame-12345';
  const { errors } = checkSecrets(prod({ JWT_SECRET: weak }));

  assert.equal(errors.length, 1);
  assert.ok(
    !errors.join(' ').includes(weak),
    `the message named the value instead of the problem: ${errors.join(' ')}`,
  );
});

test('the default database password is reported, not fatal', async () => {
  const { errors, warnings } = checkSecrets(prod({ DB_PASSWORD: 'postgres' }));

  assert.deepEqual(errors, [], 'a local database is the operator\'s decision to harden, not a deploy failure');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /DB_PASSWORD/);
  assert.match(warnings[0], /rotate the role password/);
});

test('an unset database password is reported too', async () => {
  const { errors, warnings } = checkSecrets(prod({ DB_PASSWORD: undefined }));

  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, 'config would fall back to the default, so this says so');
  assert.match(warnings[0], /DB_PASSWORD is not set/);
});

test('development is never refused, however bare the environment', async () => {
  // A fresh clone with no .env at all must still run, and that is exactly the
  // state the config fallback exists for. Refusing here would mean the guard
  // broke the first-run experience to protect a deployment that is not one.
  assert.deepEqual(checkSecrets({}), { errors: [], warnings: [] });
  assert.deepEqual(
    checkSecrets({ NODE_ENV: 'development', JWT_SECRET: 'dev-jwt-secret', DB_PASSWORD: 'postgres' }),
    { errors: [], warnings: [] },
  );
});

test('a NODE_ENV typed by hand still counts as production', async () => {
  // Case and whitespace come from hand-edited files, so neither may quietly
  // switch the protection off: `Production` must still be checked, and it is
  // checked with a bare environment, so the refusal is the secret, not casing.
  assert.equal(checkSecrets({ NODE_ENV: 'Production' }).errors.length, 1);

  // Staging is not production and has no secrets to refuse over.
  assert.deepEqual(checkSecrets({ NODE_ENV: ' staging ' }), { errors: [], warnings: [] });
});
