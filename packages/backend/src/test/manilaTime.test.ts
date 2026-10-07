import test from 'node:test';
import assert from 'node:assert/strict';
import {
  manilaDateKey,
  manilaDateTimeKey,
  parseDateKey,
  parseManilaDateTime,
  eventDateKey,
  entryDateBounds,
} from '../services/manilaTime';

test('the calendar day is Manila\'s, not UTC\'s and not the server\'s', async () => {
  // 17:14Z is 01:14 the next morning in Manila and 20:14 the same evening in
  // the server\'s own UTC+3. One instant, three candidate days: Manila wins,
  // because that is the day the operator is working.
  assert.equal(manilaDateKey(new Date('2026-10-05T17:14:07Z')), '2026-10-06');
  assert.equal(manilaDateKey(new Date('2026-10-05T15:59:59Z')), '2026-10-05');

  // The UTC day and the Manila day for the same instant disagree — that
  // disagreement is the whole reason this helper exists.
  const crossing = new Date('2026-10-05T17:14:07Z');
  assert.equal(crossing.toISOString().slice(0, 10), '2026-10-05');
  assert.equal(manilaDateKey(crossing), '2026-10-06');

  // Manila midnight, stated as an instant rather than guessed from a clock.
  assert.equal(manilaDateKey(new Date('2026-10-05T16:00:00Z')), '2026-10-06');
});

test('the wall clock is printed in Manila', async () => {
  assert.equal(manilaDateTimeKey(new Date('2026-10-05T17:14:07Z')), '2026-10-06T01:14');
  // Midnight has to read 00:00, not 24:00 — hourCycle h23 rather than h23's
  // looser sibling, which some engines render as 24 in 12-hour-leaning locales.
  assert.equal(manilaDateTimeKey(new Date('2026-10-05T16:00:00Z')), '2026-10-06T00:00');
});

test('a date key is only accepted if it names a real day', async () => {
  const valid = parseDateKey('2026-10-06');
  assert.ok(valid);
  assert.equal(valid!.toISOString(), '2026-10-05T16:00:00.000Z');

  assert.equal(parseDateKey('2026-02-30'), null, 'rolls into March otherwise');
  assert.equal(parseDateKey('2026-13-01'), null);
  assert.equal(parseDateKey('2026-1-06'), null, 'padding is part of the shape');
  assert.equal(parseDateKey('06/10/2026'), null);
  assert.equal(parseDateKey(''), null);
  assert.equal(parseDateKey('not a date'), null);
});

test('a typed instant is anchored in Manila', async () => {
  const morning = parseManilaDateTime('2026-10-06T09:00');
  assert.ok(morning);
  assert.equal(morning!.toISOString(), '2026-10-06T01:00:00.000Z');

  // The failure this exists for: taken as the server\'s local time the same
  // string lands five hours earlier, in the previous Manila day.
  assert.notEqual(morning!.toISOString(), '2026-10-06T06:00:00.000Z');

  const withSeconds = parseManilaDateTime('2026-10-06T09:00:15');
  assert.equal(withSeconds!.toISOString(), '2026-10-06T01:00:15.000Z');

  const dateOnly = parseManilaDateTime('2026-10-06');
  assert.equal(dateOnly!.toISOString(), '2026-10-05T16:00:00.000Z');
});

test('a value that already knows its offset is not shifted again', async () => {
  // A round trip through a timestamptz column arrives as UTC; re-reading it as
  // Manila wall time would move it a second time.
  const already = parseManilaDateTime('2026-10-06T01:00:00.000Z');
  assert.equal(already!.toISOString(), '2026-10-06T01:00:00.000Z');

  const offset = parseManilaDateTime('2026-10-06T09:00:00+08:00');
  assert.equal(offset!.toISOString(), '2026-10-06T01:00:00.000Z');

  assert.equal(parseManilaDateTime(''), null);
  assert.equal(parseManilaDateTime('yesterday'), null);
});

// A regression pin. This window used to be built from both ends as instants,
// and the close sliced its UTC day: Oct 6 00:00 Manila is Oct 5 16:00 UTC, so
// `end` of Oct 6 bound `entry_date < 2026-10-06` and dropped the last day out
// of every period's figures — while the period the report echoed still read
// Oct 1-6. Cash Management sent no dates (D18) so it stayed dormant; the
// statement becoming a Reports report (R3) is what put a period on it.
test('a period closes on the next Manila day, not on the UTC day of its end', async () => {
  const start = parseDateKey('2026-10-01')!;
  const end = parseDateKey('2026-10-06')!;
  const { conds, params } = entryDateBounds('l', 1, start, end);

  assert.deepEqual(conds, [
    'l.entry_date >= $1',
    'l.entry_date < ($2::date + INTERVAL \'1 day\')',
  ]);

  // Opens at the instant Oct 1 begins in Manila, so nothing earlier slips in.
  assert.equal(params[0], '2026-09-30T16:00:00.000Z');

  // Closes on the day the operator picked, which is the day *included* — the
  // predicate adds the day the window stops at.
  assert.equal(params[1], '2026-10-06');
  assert.equal(end.toISOString().slice(0, 10), '2026-10-05', 'the UTC day, for contrast');
  assert.notEqual(params[1], end.toISOString().slice(0, 10));

  // Returned together so one end being right cannot hide the other being wrong.
  assert.deepEqual(entryDateBounds('l', 1, start, null).conds, ['l.entry_date >= $1']);
  assert.deepEqual(entryDateBounds('l', 1, null, null), { conds: [], params: [] });

  // Parameter numbering has to leave room for whatever the caller binds next.
  const offset = entryDateBounds('l', 3, start, end);
  assert.deepEqual(offset.conds, [
    'l.entry_date >= $3',
    'l.entry_date < ($4::date + INTERVAL \'1 day\')',
  ]);
});

test('the day to hold a shift to falls back to now when nothing was given', async () => {
  const supplied = parseManilaDateTime('2026-10-05T09:00')!;
  assert.equal(eventDateKey(supplied), '2026-10-05');
  assert.equal(eventDateKey('2026-10-05T09:00'), '2026-10-05');
  assert.equal(eventDateKey('2026-10-05'), '2026-10-05');

  const live = eventDateKey();
  assert.equal(live, manilaDateKey());
  assert.equal(eventDateKey(null), live);
  assert.equal(eventDateKey(undefined), live);
  assert.equal(eventDateKey(new Date('nonsense')), live, 'a broken date must not widen the gate');
});
