import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInfo, resetBuildInfoCache } from '../services/buildInfo';

// /health reads this, so the contract that matters is that it always answers.
// A build made without `scripts/build-info.js` — the test build, a bare `tsc`,
// a checkout stripped of .git — still has to produce a health check, and a
// health endpoint that throws is worse than one that says 'unknown'.
//
// The assertions are about the shape rather than the values, deliberately: the
// real build writes a genuine commit, and a test that pinned 'unknown' would
// fail on exactly the healthy case it is meant to protect.

test('buildInfo always answers with a complete shape', () => {
  resetBuildInfoCache();
  const info = buildInfo();

  assert.equal(typeof info.commit, 'string');
  assert.ok(info.commit.length > 0, 'commit must not be empty');
  assert.equal(typeof info.commitShort, 'string');
  assert.ok(info.commitShort.length > 0, 'commitShort must not be empty');
  assert.equal(typeof info.branch, 'string');
  assert.equal(typeof info.dirty, 'boolean');
  assert.equal(typeof info.builtAt, 'string');
  assert.ok(info.builtAt.length > 0, 'builtAt must not be empty');
  assert.equal(typeof info.node, 'string');
  assert.ok(info.node.length > 0, 'node must not be empty');
});

test('the short commit is the long one, shortened', () => {
  resetBuildInfoCache();
  const info = buildInfo();

  // 'unknown' is the only value shortening does not apply to, and either way the
  // short form must never be longer than what it abbreviates.
  assert.ok(info.commitShort.length <= 7 || info.commitShort === 'unknown');
  if (info.commit !== 'unknown' && info.commitShort !== 'unknown') {
    assert.equal(info.commitShort, info.commit.slice(0, 7));
  }
});

test('the answer is cached, because /health is polled and the file cannot change mid-process', () => {
  resetBuildInfoCache();
  const first = buildInfo();
  const second = buildInfo();
  assert.equal(first, second, 'a second call must return the cached object, not re-read the file');
});

test('resetting the cache yields an equally valid read', () => {
  // Values, not identity: with no build-info.json present (the test build) both
  // reads return the same shared constant, so asserting the references differ
  // would fail on the very case this module is designed to survive.
  const first = buildInfo();
  resetBuildInfoCache();
  const second = buildInfo();
  assert.deepEqual(first, second);
});
