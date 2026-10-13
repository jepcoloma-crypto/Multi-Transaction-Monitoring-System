import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintShiftOverrideToken, verifyShiftOverrideToken } from '../services/shiftOverride';

// The approval a back-dated shift lives or dies by (D38). Every property that
// makes it a signature rather than a checkbox is pinned here: who it names,
// where and when it may be spent, and that nothing inside it can be edited
// after issue.

const SECRET = 'a-test-secret';
const BRANCH = 'branch-1';
const DAY = '2026-10-06';
const ADMIN = 'admin-user-id';
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

test('an approval names the administrator who gave it, for this branch and this day', () => {
  const token = mintShiftOverrideToken(ADMIN, BRANCH, DAY, SECRET, NOW);
  assert.deepEqual(verifyShiftOverrideToken(token, BRANCH, DAY, SECRET, NOW), { adminUserId: ADMIN });
});

test('the approval is worth five minutes, not the rest of the shift', () => {
  const token = mintShiftOverrideToken(ADMIN, BRANCH, DAY, SECRET, NOW);
  // The last millisecond inside the window, and the first one past it: the
  // expiry names the second it dies, not the one after.
  assert.deepEqual(
    verifyShiftOverrideToken(token, BRANCH, DAY, SECRET, NOW + 5 * 60 * 1000 - 1),
    { adminUserId: ADMIN },
  );
  assert.equal(
    verifyShiftOverrideToken(token, BRANCH, DAY, SECRET, NOW + 5 * 60 * 1000),
    null,
  );
});

test('an approval for one day cannot be spent on another, nor on another branch', () => {
  const token = mintShiftOverrideToken(ADMIN, BRANCH, DAY, SECRET, NOW);
  assert.equal(verifyShiftOverrideToken(token, BRANCH, '2026-10-07', SECRET, NOW), null);
  assert.equal(verifyShiftOverrideToken(token, 'branch-2', DAY, SECRET, NOW), null);
});

test('a token signed with another key is not a token at all', () => {
  const token = mintShiftOverrideToken(ADMIN, BRANCH, DAY, 'some-other-secret', NOW);
  assert.equal(verifyShiftOverrideToken(token, BRANCH, DAY, SECRET, NOW), null);
});

test('a payload edited after the fact fails its signature', () => {
  const token = mintShiftOverrideToken(ADMIN, BRANCH, DAY, SECRET, NOW);
  const [body, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  // The forger's move: spend the same signature on a different day.
  payload.d = '2026-10-07';
  const forged = Buffer.from(JSON.stringify(payload)).toString('base64url');
  assert.equal(verifyShiftOverrideToken(`${forged}.${signature}`, BRANCH, '2026-10-07', SECRET, NOW), null);
});

test('anything that is not a well-formed approval is refused without a guess', () => {
  for (const bad of [null, undefined, 42, '', 'nonsense', 'a.b.c', '.sig', 'body.', 'x.y']) {
    assert.equal(verifyShiftOverrideToken(bad, BRANCH, DAY, SECRET, NOW), null, String(bad));
  }
});

test('two approvals of the same day are not the same token', () => {
  // The nonce: a captured token cannot be matched by hash against the next
  // approval the admin gives, so what was stolen cannot be recognised.
  const first = mintShiftOverrideToken(ADMIN, BRANCH, DAY, SECRET, NOW);
  const second = mintShiftOverrideToken(ADMIN, BRANCH, DAY, SECRET, NOW);
  assert.notEqual(first, second);
  assert.deepEqual(verifyShiftOverrideToken(second, BRANCH, DAY, SECRET, NOW), { adminUserId: ADMIN });
});
