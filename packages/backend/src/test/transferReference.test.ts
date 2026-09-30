import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintTransferReference } from '../services/transferReference';

test('mints a prefixed, zero-padded reference', () => {
  assert.equal(mintTransferReference(28, new Date('2026-09-29T08:04:32Z')), 'TRF-2026-000028');
  assert.equal(mintTransferReference(1, new Date('2026-01-01T00:00:00Z')), 'TRF-2026-000001');
  assert.equal(mintTransferReference(999999, new Date('2026-06-15T12:00:00Z')), 'TRF-2026-999999');
});

test('never truncates once the sequence passes six digits', () => {
  // to_char(number, 'FM000000') returns '######' past this point and lpad()
  // silently chops the number, so either would make every transfer from a
  // million onwards collide on the same reference.
  assert.equal(mintTransferReference(1000000, new Date('2027-03-04T00:00:00Z')), 'TRF-2027-1000000');
  assert.notEqual(
    mintTransferReference(999999, new Date('2027-03-04T00:00:00Z')),
    mintTransferReference(1000000, new Date('2027-03-04T00:00:00Z'))
  );
});

test('labels the year in UTC rather than local time', () => {
  // 2026-12-31T20:00Z is already 2027-01-01 in Asia/Manila, and the reference
  // must agree with how created_at is stored rather than how it is displayed.
  assert.equal(mintTransferReference(42, new Date('2026-12-31T20:00:00Z')), 'TRF-2026-000042');
  assert.equal(mintTransferReference(42, new Date('2027-01-01T00:00:00Z')), 'TRF-2027-000042');
});

test('every sequence number maps to a distinct reference', () => {
  const at = new Date('2026-09-29T00:00:00Z');
  const refs = new Set(Array.from({ length: 50 }, (_, i) => mintTransferReference(i + 21, at)));
  assert.equal(refs.size, 50);
});

test('refuses to mint from a number the sequence could never produce', () => {
  const at = new Date('2026-01-01T00:00:00Z');
  for (const n of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => mintTransferReference(n, at), /transfer number/);
  }
});
