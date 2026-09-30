import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGapFix, isGapFixDirection, GAP_FIX_DIRECTIONS, GAP_FIX_LABELS } from '../services/gapFixPlan';
import type { GapFixPlan } from '../services/gapFixPlan';
import type { AccountAudit } from '../services/ledgerAudit';

const round2 = (n: number) => Math.round(n * 100) / 100;

function audit(overrides: Partial<AccountAudit> = {}): AccountAudit {
  return {
    id: 'acct-1',
    name: 'Test Account',
    status: 'active',
    openingBalance: 0,
    netMovement: 0,
    expectedBalance: 0,
    currentBalance: 0,
    gap: 0,
    entryCount: 0,
    chainBreaks: 0,
    negativeBalances: 0,
    unlinkedEntries: 0,
    lastLedgerBalance: null,
    issues: [],
    reconciled: true,
    ...overrides,
  };
}

// What the account would look like once this plan has been applied. Both
// directions are judged by the same bar the approve gate uses: the gap is gone
// and the ledger's last row ends where the balance says it does.
function afterApply(a: AccountAudit, plan: GapFixPlan) {
  if (plan.direction === 'record_entry') {
    const signed = plan.entryType === 'credit' ? plan.amount : -plan.amount;
    return {
      expected: round2(a.expectedBalance + signed),
      current: a.currentBalance,
      last: plan.balanceAfter!,
    };
  }
  return {
    expected: a.expectedBalance,
    current: plan.newBalance!,
    last: a.lastLedgerBalance ?? a.openingBalance,
  };
}

function assertCloses(a: AccountAudit, plan: GapFixPlan) {
  assert.deepEqual(plan.problems, []);
  const result = afterApply(a, plan);
  assert.equal(round2(result.expected - result.current), 0, 'gap should be zero after the fix');
  assert.equal(result.last, result.current, 'ledger tail should match the balance after the fix');
}

test('only the two gap-fix directions exist, and both are labelled', () => {
  assert.deepEqual([...GAP_FIX_DIRECTIONS], ['record_entry', 'adjust_balance']);
  assert.deepEqual(Object.keys(GAP_FIX_LABELS).sort(), ['adjust_balance', 'record_entry']);
  assert.equal(isGapFixDirection('record_entry'), true);
  assert.equal(isGapFixDirection('adjust_balance'), true);
  assert.equal(isGapFixDirection('transfer'), false);
  assert.equal(isGapFixDirection(undefined), false);
});

test('record_entry on an unexplained surplus credits the ledger up to the untouched balance', () => {
  // Nelia: opening 0, no rows, balance 3729 the ledger cannot account for.
  const a = audit({ currentBalance: 3729, gap: -3729, issues: ['balance gap of -3729.00'] });

  const plan = planGapFix(a, 'record_entry');

  assert.equal(plan.amount, 3729);
  assert.equal(plan.entryType, 'credit');
  assert.equal(plan.balanceAfter, 3729);
  assert.equal(plan.newBalance, null, 'the balance must not move');
  assertCloses(a, plan);
});

test('record_entry on a ledger that outruns the balance debits the difference', () => {
  const a = audit({
    openingBalance: 100,
    netMovement: 900,
    expectedBalance: 1000,
    currentBalance: 600,
    lastLedgerBalance: 1000,
    entryCount: 3,
    gap: 400,
  });

  const plan = planGapFix(a, 'record_entry');

  assert.equal(plan.amount, 400);
  assert.equal(plan.entryType, 'debit');
  assert.equal(plan.balanceAfter, 600);
  assertCloses(a, plan);
});

test('adjust_balance corrects the balance to what the ledger already implies and writes no row', () => {
  const a = audit({ currentBalance: 3729, gap: -3729 });

  const plan = planGapFix(a, 'adjust_balance');

  assert.equal(plan.newBalance, 0);
  assert.equal(plan.entryType, null, 'moving both sides together would leave the gap untouched');
  assert.equal(plan.balanceAfter, null);
  assertCloses(a, plan);
});

test('adjust_balance can also lift a balance the ledger says is short', () => {
  const a = audit({
    openingBalance: 100,
    netMovement: 900,
    expectedBalance: 1000,
    currentBalance: 600,
    lastLedgerBalance: 1000,
    entryCount: 3,
    gap: 400,
  });

  const plan = planGapFix(a, 'adjust_balance');

  assert.equal(plan.newBalance, 1000);
  assert.equal(plan.amount, 400);
  assertCloses(a, plan);
});

test('an account with nothing wrong is refused rather than "fixed"', () => {
  const a = audit({ reconciled: true });
  for (const direction of GAP_FIX_DIRECTIONS) {
    const plan = planGapFix(a, direction);
    assert.equal(plan.problems.length, 1);
    assert.match(plan.problems[0], /no balance gap/);
    assert.equal(plan.amount, 0);
  }
});

test('an unrecognised direction is refused and plans nothing', () => {
  const a = audit({ currentBalance: 100, gap: -100 });
  const plan = planGapFix(a, 'write_off');

  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /unknown direction/);
  assert.equal(plan.entryType, null);
  assert.equal(plan.balanceAfter, null);
  assert.equal(plan.newBalance, null);
});

test('a broken chain is refused — a gap fix closes the balance, not the chain', () => {
  const a = audit({
    expectedBalance: 100,
    currentBalance: 250,
    lastLedgerBalance: 100,
    entryCount: 4,
    chainBreaks: 2,
    gap: -150,
  });

  for (const direction of GAP_FIX_DIRECTIONS) {
    const plan = planGapFix(a, direction);
    assert.equal(plan.problems.length, 1);
    assert.match(plan.problems[0], /2 broken chain link/);
    assert.equal(plan.amount, 150, 'the amount is still derived, but nothing is planned');
    assert.equal(plan.entryType, null);
    assert.equal(plan.newBalance, null);
  }
});

test('negative ledger rows are refused because the fix would leave them behind', () => {
  const a = audit({
    expectedBalance: -20,
    currentBalance: 30,
    lastLedgerBalance: -20,
    entryCount: 2,
    negativeBalances: 1,
    gap: -50,
  });

  const plan = planGapFix(a, 'adjust_balance');
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /negative balance/);
});

test('a chain that disagrees with itself is refused in both directions', () => {
  // The rows end at 200, but opening plus movement says 100 — the balance agrees
  // with the rows, so neither side can be declared wrong without a second defect.
  const a = audit({
    expectedBalance: 100,
    currentBalance: 200,
    lastLedgerBalance: 200,
    entryCount: 1,
    gap: -100,
  });

  for (const direction of GAP_FIX_DIRECTIONS) {
    const plan = planGapFix(a, direction);
    assert.equal(plan.problems.length, 1);
    assert.match(plan.problems[0], /chain disagrees with itself/);
    assert.equal(plan.entryType, null);
    assert.equal(plan.newBalance, null);
  }
});

test('adjust_balance is refused when the implied balance would go negative', () => {
  const a = audit({ openingBalance: -50, expectedBalance: -50, currentBalance: 0, gap: -50 });

  const plan = planGapFix(a, 'adjust_balance');

  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /below zero/);
});

test('record_entry is refused when the balance it would land on is already negative', () => {
  const a = audit({ expectedBalance: 0, currentBalance: -10, gap: 10 });

  const plan = planGapFix(a, 'record_entry');

  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /negative account balance/);
});

test('several defects are reported together instead of one at a time', () => {
  const a = audit({
    expectedBalance: 100,
    currentBalance: 250,
    lastLedgerBalance: 300,
    entryCount: 4,
    chainBreaks: 1,
    negativeBalances: 2,
    gap: -150,
  });

  const plan = planGapFix(a, 'record_entry');

  assert.equal(plan.problems.length, 3);
});

test('a genuine gap on an otherwise sound ledger plans an exact amount in both directions', () => {
  const a = audit({
    openingBalance: 972,
    netMovement: 349,
    expectedBalance: 1321,
    currentBalance: 1100,
    lastLedgerBalance: 1321,
    entryCount: 107,
    gap: 221,
  });

  assertCloses(a, planGapFix(a, 'record_entry'));
  assertCloses(a, planGapFix(a, 'adjust_balance'));
});

test('an unreadable balance is reported rather than planned around', () => {
  const a = audit({ openingBalance: NaN, expectedBalance: NaN, currentBalance: NaN, gap: NaN });

  const plan = planGapFix(a, 'record_entry');

  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /could not be read/);
  assert.equal(plan.gap, 0, 'a NaN gap must not leak into the recorded amount');
  assert.equal(plan.amount, 0);
  assert.equal(plan.entryType, null);
  assert.equal(plan.balanceAfter, null);
  assert.equal(plan.newBalance, null);
});
