import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawerWindow } from '../services/drawerQuery';

test('a movement stamped in the opening minute falls inside the window', () => {
  // The bug this exists for: `opened_at` carries sub-second precision while a
  // transaction's `entry_date` only carries the minute the operator typed, so
  // 05:33:00 read as *before* a shift opened at 05:33:07 and dropped out.
  const { from, to } = drawerWindow('2026-10-06T05:33:07.248132+08:00', '2026-10-06T17:00:00+08:00');

  const movement = new Date('2026-10-06T05:33:00+08:00');
  assert.ok(movement >= from, 'opening-minute movement must not fall before the window');
  assert.ok(movement < to, 'opening-minute movement must fall before the close');
});

test('the window opens at the start of the minute and closes at the exact instant', () => {
  const { from, to } = drawerWindow('2026-10-06T05:33:07.248132+08:00', '2026-10-06T17:00:42.5+08:00');

  assert.equal(from.toISOString(), '2026-10-05T21:33:00.000Z');
  assert.equal(to.toISOString(), '2026-10-06T09:00:42.500Z');
});

test('a movement from the minute before the shift stays outside', () => {
  const { from } = drawerWindow('2026-10-06T05:33:07.248132+08:00', '2026-10-06T17:00:00+08:00');

  assert.ok(new Date('2026-10-06T05:32:00+08:00') < from);
});

test('an open shift closes on now rather than on a null', () => {
  const before = Date.now();
  const { to } = drawerWindow('2026-10-06T05:33:07.248132+08:00', null);
  const after = Date.now();

  assert.ok(to.getTime() >= before && to.getTime() <= after);
});

test('flooring is done in UTC so no host timezone decides the minute', () => {
  // Manila (UTC+8) and this host (UTC+3) are both whole-minute offsets, so
  // they share minute boundaries — flooring one floors the other.
  const { from } = drawerWindow('2026-10-06T05:33:07+08:00', '2026-10-06T17:00:00+08:00');
  assert.equal(from.getTime() % 60_000, 0);
});
