// What has to be true about the configuration before this server runs.
//
// JWT_SECRET and DB_PASSWORD are read from the environment with a published
// constant as the fallback when they are absent (config/index.ts). An unset
// variable therefore never fails — it quietly becomes a value that ships in
// this repository, which for the signing secret means anyone who has read the
// code can mint a token this server will accept. The app would start, the log
// would look healthy, and logins would work. That is the whole symptom.
//
// So the check runs once at startup, before the database is touched, and
// refuses to start rather than serve. Only production can be refused: a
// developer on a fresh clone with no .env must still be able to run the thing,
// and development already means `dev-jwt-secret` on purpose.
//
// The database password is reported but does not block. On this deployment the
// database listens on localhost only, so the default is a hardening step for
// the operator — rotate the role, then the .env — and not something a deploy
// should be able to fail the process over.
//
// Nothing here ever prints a value that could be a real secret: the messages
// name the variable and the reason, never the contents.

export interface SecretReport {
  /** Blocks startup: a production run in this state is not safe to serve. */
  errors: string[];
  /** Worth saying out loud, but the operator's call, not a deploy's. */
  warnings: string[];
}

export const MIN_JWT_SECRET_LENGTH = 32;

// Placeholders that appear in the repository itself — config's own fallback,
// the example .env, docker-compose, and the usual guesses. They are published
// by being in the tree, so length proves nothing about them: the example
// placeholder below is 49 characters.
const PUBLISHED_JWT_SECRETS = [
  'dev-jwt-secret',
  'change-me-in-production',
  'change-me-in-production-use-a-strong-random-secret',
  'secret',
  'jwt-secret',
  'your-secret-key',
  'changeme',
].map((value) => value.toLowerCase());

const DEFAULT_DB_PASSWORD = 'postgres';

export function checkSecrets(env: Record<string, string | undefined>): SecretReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  if ((env.NODE_ENV || '').trim().toLowerCase() !== 'production') return { errors, warnings };

  const secret = (env.JWT_SECRET || '').trim();
  if (!secret) {
    errors.push('JWT_SECRET is not set — every token would be signed with the published fallback.');
  } else if (PUBLISHED_JWT_SECRETS.includes(secret.toLowerCase())) {
    // Before the length rule on purpose: `dev-jwt-secret` is short, and "too
    // short" would invite padding a published constant with characters rather
    // than generating a real one. The placeholder message is the true reason.
    errors.push('JWT_SECRET is a placeholder published in this repository.');
  } else if (secret.length < MIN_JWT_SECRET_LENGTH) {
    errors.push(`JWT_SECRET is shorter than ${MIN_JWT_SECRET_LENGTH} characters.`);
  }

  const password = (env.DB_PASSWORD || '').trim();
  if (!password || password === DEFAULT_DB_PASSWORD) {
    warnings.push(
      `DB_PASSWORD is ${password ? 'the default' : 'not set'} — acceptable while the database ` +
      'is local-only; rotate the role password before it is reachable from anywhere else.',
    );
  }

  return { errors, warnings };
}
