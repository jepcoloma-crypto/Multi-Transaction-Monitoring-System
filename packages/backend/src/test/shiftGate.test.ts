import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOpenShift } from '../middleware/shiftGate';
import type { ShiftLookups } from '../middleware/shiftGate';

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
  async shift() { return { id: 'sh-1' }; }
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
  await assertOpenShift('acc-1', 'owner_funding', mustNotQuery);
  await assertOpenShift('acc-1', 'owner_return', mustNotQuery);
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
      () => assertOpenShift('acc-1', code, closedBranch),
      isStatus(409),
      `${code} should require an open shift`,
    );
  }
});

test('an absent or null type is gated, never read as exempt', async () => {
  // The failure mode this guards: `if (!typeCode) return;` would wave through
  // every transfer and loading movement, which carry no type at all — two of
  // the three flows the requirement names.
  await assert.rejects(() => assertOpenShift('acc-1', undefined, closedBranch), isStatus(409));
  await assert.rejects(() => assertOpenShift('acc-1', null, closedBranch), isStatus(409));
  await assert.rejects(() => assertOpenShift('acc-1', '', closedBranch), isStatus(409));
});

test('a closed branch is refused with the remedy and the branch named', async () => {
  await assert.rejects(
    () => assertOpenShift('acc-1', 'cash_out', closedBranch),
    isStatus(409, /No open shift for branch MAIN — open a shift/),
  );
});

test('an open shift lets the movement through', async () => {
  await assertOpenShift('acc-1', 'cash_out', openBranch);
  await assertOpenShift('acc-1', undefined, openBranch);
});

test('a missing account is 404, not 409', async () => {
  // Answering 409 here would confirm the account exists — the same reason
  // assertBranch answers 404 for a caller outside the branch.
  const noAccount: ShiftLookups = {
    async account() { return null; },
    async shift() { return { id: 'sh-1' }; },
  };

  await assert.rejects(
    () => assertOpenShift('acc-nope', 'cash_out', noAccount),
    isStatus(404, /Account not found/),
  );
});

test('the shift is looked up on the account\'s own branch', async () => {
  const seen: string[] = [];
  const tracking: ShiftLookups = {
    async account() { return { branch_id: 'br-rm', code: 'RM' }; },
    async shift(branchId) { seen.push(branchId); return { id: 'sh-2' }; },
  };

  await assertOpenShift('acc-1', 'cash_in', tracking);
  assert.deepEqual(seen, ['br-rm']);
});
