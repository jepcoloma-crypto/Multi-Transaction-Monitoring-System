import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReferenceIsNew } from '../services/referenceRule';
import type { ReferenceDb } from '../services/referenceRule';

// A fixed day rather than today's: an assertion that passed because the clock
// had not moved yet would fail one minute later, across the Manila midnight.
const onDay = new Date('2026-10-06T09:00:00+08:00');
const priorDay = new Date('2026-10-05T09:00:00+08:00');

const isStatus =
  (status: number, pattern?: RegExp) =>
  (err: any): boolean => {
    if (err?.statusCode !== status) return false;
    if (pattern && !pattern.test(err.message)) return false;
    return true;
  };

// Stands in for the pool or the caller's client, recording what was asked so a
// test can read the window and the clauses back. `row` is what the query
// "finds": null meaning no standing duplicate exists.
const stub = (row: any = null) => {
  const calls: { text: string; params: any[] }[] = [];
  const db: ReferenceDb = {
    async query(text: string, params?: any[]) {
      calls.push({ text, params: params ?? [] });
      return { rows: row === null ? [] : [row] };
    },
  };
  return { db, calls };
};

const mustNotQuery: ReferenceDb = {
  async query() {
    throw new Error('the database must not be reached when there is no reference');
  },
};

test('a blank or absent reference never reaches the database', async () => {
  // Three rows in the data carry no reference, and a blank field is how the
  // forms ask for "none". None of them can duplicate anything.
  await assertReferenceIsNew(mustNotQuery, { accountId: 'acc-1', referenceNumber: '' });
  await assertReferenceIsNew(mustNotQuery, { accountId: 'acc-1', referenceNumber: '    ' });
  await assertReferenceIsNew(mustNotQuery, { accountId: 'acc-1', referenceNumber: null });
  await assertReferenceIsNew(mustNotQuery, { accountId: 'acc-1', referenceNumber: undefined });
  await assertReferenceIsNew(mustNotQuery, { accountId: 'acc-1', referenceNumber: 0 as any });
});

test('a reference already standing on this account and day is refused', async () => {
  const { db } = stub({ transaction_number: 131, status: 'completed' });

  // The whitespace matters: what the operator typed is compared after trim,
  // and the number quoted back to them is the same one they gave.
  await assert.rejects(
    () => assertReferenceIsNew(db, {
      accountId: 'acc-1', referenceNumber: '  36855  ', eventDate: onDay,
    }),
    isStatus(409, /Reference 36855 is already recorded on this account as TX #131 \(completed\) for 2026-10-06\./),
  );
});

test('the remedy offered is one the operator can actually perform', async () => {
  // A pending row is still theirs to fix; telling them to reverse a completed
  // one would send an administrator to the wrong screen.
  const pending = stub({ transaction_number: 7, status: 'pending' });
  await assert.rejects(
    () => assertReferenceIsNew(pending.db, { accountId: 'acc-1', referenceNumber: '9', eventDate: onDay }),
    isStatus(409, /Edit or cancel that entry/),
  );

  const completed = stub({ transaction_number: 8, status: 'completed' });
  await assert.rejects(
    () => assertReferenceIsNew(completed.db, { accountId: 'acc-1', referenceNumber: '9', eventDate: onDay }),
    isStatus(409, /If this is the same event recorded again, reverse the original first\./),
  );
});

test('nothing is refused when no standing row is found', async () => {
  const { db, calls } = stub(null);

  await assertReferenceIsNew(db, { accountId: 'acc-1', referenceNumber: '36855', eventDate: onDay });

  assert.equal(calls.length, 1, 'exactly one lookup, not a read followed by a write');
});

test('the window is the Manila day, not the server clock or UTC', async () => {
  // 00:30 typed in Manila is 16:30 of the previous day in UTC. Read as UTC the
  // search would look at the wrong day and wave a genuine repeat straight
  // through — the exact disagreement this deployment's three clocks cause.
  const { db, calls } = stub(null);
  await assertReferenceIsNew(db, { accountId: 'acc-1', referenceNumber: '1', eventDate: '2026-10-06T00:30' });

  const [, start, end] = calls[0].params;
  assert.equal(start, '2026-10-05T16:00:00.000Z', 'Manila midnight on the 6th, as an instant');
  assert.equal(end, '2026-10-06T16:00:00.000Z', 'a fixed 24 hours on, because the Philippines has no DST');
});

test('the day is taken from the row being written, not from now', async () => {
  const { db, calls } = stub(null);
  await assertReferenceIsNew(db, { accountId: 'acc-1', referenceNumber: '1', eventDate: priorDay });

  const [, start] = calls[0].params;
  assert.equal(start, '2026-10-04T16:00:00.000Z', 'the 5th, however far off today is');
});

test('only the caller\'s own account is asked about', async () => {
  // Two different customers can perfectly well hold the same receipt number
  // from different billers, so a reference is scoped to the account it is
  // recorded against rather than treated as globally unique.
  const { db, calls } = stub(null);
  await assertReferenceIsNew(db, { accountId: 'acc-1', referenceNumber: '68975', eventDate: onDay });

  assert.match(calls[0].text, /t\.account_id = \$1/);
  assert.equal(calls[0].params[0], 'acc-1');
});

test('a reversed original does not stand in the way of its re-entry', async () => {
  // The whole reason this is a query and not a UNIQUE index. Both repeats
  // already in the data are a reversal and the corrected entry that follows,
  // and each pair shares its reference because the event never changed.
  const { db, calls } = stub(null);
  await assertReferenceIsNew(db, { accountId: 'acc-1', referenceNumber: '36855', eventDate: onDay });

  assert.match(
    calls[0].text,
    /t\.status IS DISTINCT FROM 'reversed'/,
    'a row that has been undone no longer holds the reference — and a NULL status must count as standing, not as free',
  );
});

test('a row is allowed to keep the reference it already has', async () => {
  // Without this the administrator's edit would collide with the row being
  // edited, and the form would refuse to save a field left untouched.
  const { db, calls } = stub(null);
  await assertReferenceIsNew(db, {
    accountId: 'acc-1', referenceNumber: '555', eventDate: onDay, excludeId: 'tx-own',
  });

  assert.match(calls[0].text, /t\.id <> \$5/);
  assert.equal(calls[0].params[4], 'tx-own');

  // And the same check without an exclusion stays a four-parameter query.
  const bare = stub(null);
  await assertReferenceIsNew(bare.db, { accountId: 'acc-1', referenceNumber: '555', eventDate: onDay });
  assert.equal(bare.calls[0].params.length, 4);
});

test('matching ignores the case the reference was typed in', async () => {
  // References are read back from slips and receipts where the same value can
  // arrive in either case, so the comparison is on the value, not the casing.
  const { db, calls } = stub(null);
  await assertReferenceIsNew(db, { accountId: 'acc-1', referenceNumber: 'gcX123', eventDate: onDay });

  assert.match(calls[0].text, /UPPER\(t\.reference_number\) = UPPER\(\$4\)/);
  assert.equal(calls[0].params[3], 'gcX123', 'the value is bound, never interpolated');
});

test('the lookup is limited to one row', async () => {
  // The message names one transaction. Reading every match would only make a
  // refused submission slower to refuse — and a stub that finds nothing still
  // proves the statement, since the clause is in the SQL either way.
  const { db, calls } = stub(null);
  await assertReferenceIsNew(db, { accountId: 'acc-1', referenceNumber: '9', eventDate: onDay });

  assert.match(calls[0].text, /LIMIT 1/);
});
