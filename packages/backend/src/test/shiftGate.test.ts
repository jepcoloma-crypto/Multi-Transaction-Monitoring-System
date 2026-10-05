import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOpenShift } from '../middleware/shiftGate';
import type { ShiftLookups } from '../middleware/shiftGate';

// A fixed day rather than today's: an assertion that passed because the clock
// had not moved yet would fail one minute later, across the Manila midnight.
const DAY = '2026-10-06';
const onDay = new Date('2026-10-06T09:00:00+08:00');
const priorDay = new Date('2026-10-05T09:00:00+08:00');

// Lookups that fail loudly if they are reached at all. The exemption is worth
// as much for the queries it *skips* as for the request it lets through: if
// owner funding had to consult a shift, the drawer could not be funded before
// one existed (§16 step 1).
const mustNotQuery: ShiftLookups = {
  async account() { throw new Error('accounts must not be queried for an exempt type'); },
  async shift() { throw new Error('shifts must not be queried for an exempt type'); },
};

const closedBranch: ShiftLookups = {
  async account() { return { branch_id: 'br-main', code: 'MAIN' }; },
  async shift() { return null; },
};

const openBranch: ShiftLookups = {
  async account() { return { branch_id: 'br-main', code: 'MAIN' }; },
  async shift() { return { id: 'sh-1', shift_date: DAY }; },
};

const isStatus =
  (status: number, pattern?: RegExp) =>
  (err: any): boolean => {
    if (err?.statusCode !== status) return false;
    if (pattern && !pattern.test(err.message)) return false;
    return true;
  };

test('owner funding and returns pass without consulting anything', async () => {
  // The one exemption the whole "fund the drawers first" step rests on.
  await assertOpenShift('acc-1', 'owner_funding', { lookups: mustNotQuery });
  await assertOpenShift('acc-1', 'owner_return', { lookups: mustNotQuery });
});

test('every other transaction type is gated', async () => {
  const gated = [
    'cash_in',
    'cash_out',
    'customer_payment',
    'customer_withdrawal',
    'operating_expense',
    'expense',
    'refund',
    'adjustment_in',
    'load_purchase',
  ];

  for (const code of gated) {
    await assert.rejects(
      () => assertOpenShift('acc-1', code, { lookups: closedBranch, eventDate: onDay }),
      isStatus(409),
      `${code} should require an open shift`,
    );
  }
});

test('an absent or null type is gated, never read as exempt', async () => {
  // The failure mode this guards: `if (!typeCode) return;` would wave through
  // every transfer and loading movement, which carry no type at all — two of
  // the three flows the requirement names.
  await assert.rejects(() => assertOpenShift('acc-1', undefined, { lookups: closedBranch, eventDate: onDay }), isStatus(409));
  await assert.rejects(() => assertOpenShift('acc-1', null, { lookups: closedBranch, eventDate: onDay }), isStatus(409));
  await assert.rejects(() => assertOpenShift('acc-1', '', { lookups: closedBranch, eventDate: onDay }), isStatus(409));
});

test('a closed branch is refused with the remedy and the branch named', async () => {
  await assert.rejects(
    () => assertOpenShift('acc-1', 'cash_out', { lookups: closedBranch, eventDate: onDay }),
    isStatus(409, /No open shift for branch MAIN — open a shift/),
  );
});

test('an open shift lets a movement dated that day through', async () => {
  await assertOpenShift('acc-1', 'cash_out', { lookups: openBranch, eventDate: onDay });
  await assertOpenShift('acc-1', undefined, { lookups: openBranch, eventDate: onDay });
});

test('a movement dated another day is refused even though the shift is open', async () => {
  // The requirement: the transaction date and the shift date must be the same.
  // A shift open for the 6th and a transaction typed for the 5th cannot both be
  // right — the drawer being counted is the 6th's, and the 5th's cash would be
  // counted into it.
  await assert.rejects(
    () => assertOpenShift('acc-1', 'cash_out', { lookups: openBranch, eventDate: priorDay }),
    isStatus(409, /Dated 2026-10-05, but the open shift for branch MAIN is 2026-10-06/),
  );
});

test('the date it is typed as is read as Manila, not as the server clock', async () => {
  // The host runs UTC+3. Taken as a local naive string 00:30 would already be
  // the previous day's evening in Manila and this would pass for the wrong
  // reason; anchored in Manila it stays on the 6th.
  await assertOpenShift('acc-1', 'cash_in', {
    lookups: openBranch,
    eventDate: '2026-10-06T00:30',
  });
  await assert.rejects(
    () => assertOpenShift('acc-1', 'cash_in', { lookups: openBranch, eventDate: '2026-10-05T23:30' }),
    isStatus(409, /Dated 2026-10-05/),
  );
});

test('no date means the moment of the action, checked the same way', async () => {
  // Settling, reversing and correcting carry no date of their own: they happen
  // now, so they are held to the shift covering now. Fixed here by supplying a
  // lookup whose shift is dated for the live clock, so the assertion does not
  // depend on when the suite runs.
  const { manilaDateKey } = await import('../services/manilaTime');
  const liveDay: ShiftLookups = {
    async account() { return { branch_id: 'br-main', code: 'MAIN' }; },
    async shift() { return { id: 'sh-3', shift_date: manilaDateKey() }; },
  };

  await assertOpenShift('acc-1', 'cash_out', { lookups: liveDay });
});

test('a past-dated shift accepts a movement dated that day', async () => {
  // Backfilling yesterday's shift is allowed precisely so yesterday's
  // transactions can be recorded under it.
  const yesterday: ShiftLookups = {
    async account() { return { branch_id: 'br-main', code: 'MAIN' }; },
    async shift() { return { id: 'sh-4', shift_date: '2026-10-05' }; },
  };

  await assertOpenShift('acc-1', 'cash_out', { lookups: yesterday, eventDate: priorDay });
  await assert.rejects(
    () => assertOpenShift('acc-1', 'cash_out', { lookups: yesterday, eventDate: onDay }),
    isStatus(409, /is 2026-10-05/),
  );
});

test('a missing account is 404, not 409', async () => {
  // Answering 409 here would confirm the account exists — the same reason
  // assertBranch answers 404 for a caller outside the branch.
  const noAccount: ShiftLookups = {
    async account() { return null; },
    async shift() { return { id: 'sh-1', shift_date: DAY }; },
  };

  await assert.rejects(
    () => assertOpenShift('acc-nope', 'cash_out', { lookups: noAccount, eventDate: onDay }),
    isStatus(404, /Account not found/),
  );
});

test('the shift is looked up on the account\'s own branch', async () => {
  const seen: string[] = [];
  const tracking: ShiftLookups = {
    async account() { return { branch_id: 'br-rm', code: 'RM' }; },
    async shift(branchId) { seen.push(branchId); return { id: 'sh-2', shift_date: DAY }; },
  };

  await assertOpenShift('acc-1', 'cash_in', { lookups: tracking, eventDate: onDay });
  assert.deepEqual(seen, ['br-rm']);
});
