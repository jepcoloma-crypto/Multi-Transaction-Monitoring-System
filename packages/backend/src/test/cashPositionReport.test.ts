// Branch cash position — where the company's cash is right now.
//
// A snapshot with no date window. One open cash account per branch is the
// drawer; a branch with no cash account at all is untracked and appears with
// its state rather than vanishing, so the sheet can answer why a branch is not
// in the total. Frozen cash — on the books, no longer in anyone's hands — is
// reported beside, never inside, the countable till (the statement's own
// split).
//
// Pure: the route reads the accounts, shifts and variance counts, this decides
// what they mean.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCashPositionReport,
  type CashPositionBranch,
} from '../services/cashPositionReport';

const branch = (overrides: Partial<CashPositionBranch> = {}): CashPositionBranch => ({
  branchId: 'b1',
  name: 'Main Branch',
  drawerAccountId: 'acc1',
  drawerAccountName: 'Revolving Fund',
  drawerBalance: 126459.66,
  hasOpenShift: true,
  shiftDate: '2026-10-22',
  openingFloat: 111309.66,
  expectedClosing: 126459.66,
  openedBy: 'admin',
  lastCountedClosing: 111309.66,
  lastVariance: 0,
  lastShiftDate: '2026-10-21',
  unresolvedVarianceCount: 0,
  frozenBalance: null,
  ...overrides,
});

test('the total is the sum of the tracked tills, and untracked branches never enter it', () => {
  const report = buildCashPositionReport([
    branch({ branchId: 'b1', drawerBalance: 1000 }),
    branch({ branchId: 'b2', drawerBalance: 2000 }),
    branch({ branchId: 'b3', drawerAccountId: null, drawerAccountName: null, drawerBalance: null }),
  ]);
  assert.equal(report.summary.totalDrawerBalance, 3000);
  assert.equal(report.summary.untrackedCount, 1);
  assert.equal(report.branches.length, 3);
});

test('open shifts and unanswered variances are counted across the branches', () => {
  const report = buildCashPositionReport([
    branch({ branchId: 'b1', hasOpenShift: true, unresolvedVarianceCount: 1 }),
    branch({ branchId: 'b2', hasOpenShift: false, unresolvedVarianceCount: 2 }),
    branch({ branchId: 'b3', drawerAccountId: null }),
  ]);
  assert.equal(report.summary.openShiftCount, 1);
  assert.equal(report.summary.unresolvedVarianceCount, 3);
});

test('the biggest till comes first; a null balance reads as zero without crashing the sort', () => {
  const report = buildCashPositionReport([
    branch({ branchId: 'big', drawerBalance: 90000 }),
    branch({ branchId: 'mid', drawerBalance: 100 }),
    branch({ branchId: 'untracked', drawerAccountId: null, drawerBalance: null }),
  ]);
  assert.deepEqual(report.branches.map((br) => br.branchId), ['big', 'mid', 'untracked']);
});

test('frozen cash rides beside the branch line, never inside the total', () => {
  const report = buildCashPositionReport([
    branch({ branchId: 'b1', drawerBalance: 500, frozenBalance: 12345.67 }),
  ]);
  assert.equal(report.summary.totalDrawerBalance, 500);
  assert.equal(report.branches[0].frozenBalance, 12345.67);
});
