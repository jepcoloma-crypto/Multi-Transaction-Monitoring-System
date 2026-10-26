import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../database/connection';
import { MANILA_TZ } from '../services/manilaTime';

// The pool is what enforces the session timezone: the end-of-day bounds in
// the reports read `$n::date + INTERVAL '1 day'` in the session's timezone,
// so a pool that stops setting it moves every report window by the server's
// offset without a single line of report code changing. This test exists
// because that pin lived only in a comment until it was written down here.
test('the pool pins every session to Manila', async () => {
  const options = String((pool as any).options?.options ?? '');
  assert.match(
    options,
    new RegExp(`timezone=${MANILA_TZ.replace('/', '\\/')}`),
    `pool options were '${options}' — report day boundaries depend on this`,
  );
});

// A real session, not just the config that asked for one: the startup packet
// is the only place this is applied, so the connection is the proof. Skipped
// cleanly when no database is reachable, because this suite otherwise runs
// without one.
test('a session handed out by the pool reports Asia/Manila', async (t) => {
  let client: any;
  try {
    client = await pool.connect();
  } catch (error) {
    t.skip(`no database available: ${(error as Error).message}`);
    return;
  }
  try {
    const result = await client.query(`SELECT current_setting('timezone') AS tz`);
    assert.equal(result.rows[0].tz, MANILA_TZ);
  } finally {
    client.release();
  }
});

// This file is the only one that opens a real connection, so it owns closing
// one. Without this the pool holds its idle clients for idleTimeoutMillis
// (30s) and node --test waits out the whole window before exiting — the suite
// goes from a second to half a minute for a single query. Ending here is safe
// because node:test runs each file in its own process, so no other test
// shares this pool.
test.after(async () => {
  await pool.end();
});
