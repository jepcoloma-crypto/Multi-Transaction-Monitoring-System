import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawerWindow } from '../services/drawerQuery';
import { expectedClosing } from '../services/shifts';

// A shift opened on 8 October for the 25 September business day. Every cash row
// it moved is stamped 25 September under `entry_date` but posted on 8 October
// under `created_at`, and the window reads `created_at` — which is what keeps
// the shift's expected figure describing the drawer instead of describing the
// date field on the form.
const OPENED_AT = '2026-10-08T20:39:46.687707+08:00';

// Posted in Manila on 8 October: three rows that predate the shift — including
// the funding the count turns into the opening float — and the seventeen
// expenses paid out under it.
const POSTED: Array<[string, 'credit' | 'debit', string]> = [
  ['2026-10-08T20:17:27.808362+08:00', 'credit', '200000.00'],
  ['2026-10-08T20:25:09.662253+08:00', 'debit', '200000.00'],
  ['2026-10-08T20:39:37.00118+08:00', 'credit', '131827.00'],
  ['2026-10-08T20:40:38.289683+08:00', 'debit', '1045.00'],
  ['2026-10-08T20:42:02.295934+08:00', 'debit', '1000.00'],
  ['2026-10-08T20:44:07.008365+08:00', 'debit', '462.00'],
  ['2026-10-08T20:45:34.023745+08:00', 'debit', '150.00'],
  ['2026-10-08T20:48:42.319071+08:00', 'debit', '85.00'],
  ['2026-10-08T20:51:28.179138+08:00', 'debit', '992.00'],
  ['2026-10-08T20:52:21.926892+08:00', 'debit', '100.00'],
  ['2026-10-08T20:54:06.488512+08:00', 'debit', '12.00'],
  ['2026-10-08T20:54:51.780693+08:00', 'debit', '160.00'],
  ['2026-10-08T21:48:03.121148+08:00', 'debit', '4400.00'],
  ['2026-10-08T21:48:06.926394+08:00', 'debit', '11578.00'],
  ['2026-10-08T21:48:09.542128+08:00', 'debit', '10000.00'],
  ['2026-10-08T21:50:10.171861+08:00', 'debit', '108.00'],
  ['2026-10-08T22:00:38.333175+08:00', 'debit', '30.00'],
  ['2026-10-08T22:01:59.050597+08:00', 'debit', '30.00'],
  ['2026-10-08T22:02:38.092407+08:00', 'debit', '1200.00'],
  ['2026-10-08T22:03:26.352417+08:00', 'debit', '20.00'],
];

// A fixed close rather than `null`, so the arithmetic below does not depend on
// the wall clock the tests happen to run at. The `null` path is its own test.
const CLOSED_AT = '2026-10-09T00:00:00+08:00';

test('the window opens at the exact instant the drawer was opened', () => {
  const { from } = drawerWindow(OPENED_AT, CLOSED_AT);

  assert.equal(from.toISOString(), '2026-10-08T12:39:46.687Z');
});

test('the funding that set the float is not counted a second time', () => {
  // It posted 9.7 seconds before the drawer opened. The count that becomes the
  // opening float already includes it, so admitting it as a movement would put
  // the shift's expected figure a whole float above the drawer.
  const { from } = drawerWindow(OPENED_AT, CLOSED_AT);

  assert.ok(
    new Date('2026-10-08T20:39:37.00118+08:00') < from,
    'the float funding must stay outside the window',
  );
});

test('rows posted after the open fall inside', () => {
  const { from, to } = drawerWindow(OPENED_AT, CLOSED_AT);
  const movement = new Date('2026-10-08T20:40:38.289683+08:00');

  assert.ok(movement >= from, 'the first expense posted after the open is inside');
  assert.ok(movement < to, 'and before the close');
});

test('the close stays exact', () => {
  const { to } = drawerWindow(OPENED_AT, '2026-10-09T08:00:42.5+08:00');

  assert.equal(to.toISOString(), '2026-10-09T00:00:42.500Z');
});

test('an open shift closes on now rather than on a null', () => {
  const before = Date.now();
  const { to } = drawerWindow(OPENED_AT, null);
  const after = Date.now();

  assert.ok(to.getTime() >= before && to.getTime() <= after);
});

test('the shift expects exactly what the drawer holds', () => {
  // The whole point of the window: seventeen expenses filed under 25 September,
  // counted against a float of 131,827.00, must produce the 100,455.00 the
  // cash accounts actually carry. Before the window read `created_at`, it read
  // `entry_date`, caught nothing, and reported 131,827.00 — a shortage equal to
  // every peso the shift had paid out.
  const { from, to } = drawerWindow(OPENED_AT, CLOSED_AT);
  const movements = POSTED.filter(
    ([posted]) => new Date(posted) >= from && new Date(posted) < to,
  ).map(([, entry_type, amount]) => ({ entry_type, amount }));

  assert.equal(movements.length, 17, 'only the rows posted under the shift belong to it');
  assert.equal(expectedClosing('131827.00', movements), 100455);
});
