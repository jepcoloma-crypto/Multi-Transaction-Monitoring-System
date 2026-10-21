import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnerFundReport } from '../services/ownerFundsReport';
import type { OwnerFundSourceRow } from '../services/ownerFundsReport';

const baseRow = (overrides: Partial<OwnerFundSourceRow> = {}): OwnerFundSourceRow => ({
  id: 'txn-1',
  transaction_number: 279,
  kind: 'owner_funding',
  net_amount: '50000.00',
  additional_charges: [],
  status: 'completed',
  payment_method: 'bank',
  reference_number: null,
  description: 'Owner funding via Bank Transfer',
  notes: null,
  transaction_date: '2026-10-10T08:07:00+00:00',
  created_at: '2026-10-11T08:07:05+00:00',
  account_id: 'acct-1',
  account_name: 'Benito Bautista',
  branch_id: 'branch-1',
  branch_code: 'MAIN',
  branch_name: 'Main Branch',
  requested_by: 'remittancevanessa',
  approved_by: 'admin',
  approval_audit_actor: 'admin',
  approved_at: '2026-10-11T08:12:15+00:00',
  ...overrides,
});

test('an approved add-funds movement is reported as funding with its approver', () => {
  const report = buildOwnerFundReport([baseRow()]);

  assert.equal(report.movements.length, 1);
  const movement = report.movements[0];
  assert.equal(movement.kind, 'funding');
  assert.equal(movement.amount, 50000);
  assert.equal(movement.transactionNumber, 279);
  assert.equal(movement.accountName, 'Benito Bautista');
  assert.equal(movement.branchCode, 'MAIN');
  assert.equal(movement.requestedBy, 'remittancevanessa');
  assert.equal(movement.approvedBy, 'admin');
  assert.equal(movement.approvedAt, '2026-10-11T08:12:15.000Z');
  assert.equal(movement.settledDirectly, false);
});

test('a return is reported as a return and subtracts rather than adding', () => {
  const report = buildOwnerFundReport([baseRow({ kind: 'owner_return', transaction_number: 280 })]);

  const movement = report.movements[0];
  assert.equal(movement.kind, 'return');
  assert.equal(movement.amount, 50000);
  // The summary is what an owner reads as "what did this period do to my
  // books", so a lone return has to come out negative rather than as a
  // positive figure sitting under a "net" label.
  assert.equal(report.summary.totalReturned, 50000);
  assert.equal(report.summary.totalFunded, 0);
  assert.equal(report.summary.netToAccounts, -50000);
  assert.equal(report.summary.returnedCount, 1);
  assert.equal(report.summary.fundedCount, 0);
});

test('adds and returns net against each other instead of summing into a larger figure', () => {
  const report = buildOwnerFundReport([
    baseRow({ id: 'a', transaction_number: 1, net_amount: '50000.00' }),
    baseRow({ id: 'b', transaction_number: 2, kind: 'owner_return', net_amount: '20000.00' }),
  ]);

  assert.equal(report.summary.totalFunded, 50000);
  assert.equal(report.summary.totalReturned, 20000);
  assert.equal(report.summary.netToAccounts, 30000);
  assert.equal(report.summary.movements, 2);
});

test('a movement with no approver is named as settled directly, not left blank', () => {
  // An administrator recording an owner movement settles it at once with no
  // second signature. An empty approver cell would read as a broken join, so
  // the report says what actually happened instead.
  const report = buildOwnerFundReport([baseRow({ approved_by: null, approval_audit_actor: null })]);

  const movement = report.movements[0];
  assert.equal(movement.approvedBy, null);
  assert.equal(movement.settledDirectly, true);
  assert.equal(report.summary.settledDirectly, 1);
  assert.equal(report.summary.settledDirectlyAmount, 50000);
});

test('the audit actor is used when the approver column is empty', () => {
  const report = buildOwnerFundReport([baseRow({ approved_by: null, approval_audit_actor: 'joyce' })]);

  const movement = report.movements[0];
  assert.equal(movement.approvedBy, 'joyce');
  assert.equal(movement.settledDirectly, false);
  assert.equal(report.summary.settledDirectly, 0);
});

test('additional charges ride with the amount, matching what the approval posted', () => {
  const report = buildOwnerFundReport([
    baseRow({ net_amount: '50000.00', additional_charges: [{ code: 'gcash_fee', amount: '150.00' }] }),
  ]);

  assert.equal(report.movements[0].amount, 50150);
  assert.equal(report.summary.totalFunded, 50150);
});

test('totals are accumulated in centavos rather than floats', () => {
  // 0.1 + 0.2 is 0.30000000000000004 in binary floating point. A report whose
  // total disagrees with its own rows by a fraction is a report nobody trusts.
  const report = buildOwnerFundReport([
    baseRow({ id: 'a', transaction_number: 1, net_amount: '0.10' }),
    baseRow({ id: 'b', transaction_number: 2, net_amount: '0.20' }),
  ]);

  assert.equal(report.summary.totalFunded, 0.3);
  assert.equal(`${report.summary.totalFunded.toFixed(2)}`, '0.30');
});

test('accounts are counted once each however many times they were funded', () => {
  const report = buildOwnerFundReport([
    baseRow({ id: 'a', transaction_number: 1, account_id: 'acct-1' }),
    baseRow({ id: 'b', transaction_number: 2, account_id: 'acct-1' }),
    baseRow({ id: 'c', transaction_number: 3, account_id: 'acct-2' }),
  ]);

  assert.equal(report.summary.accountsTouched, 2);
  assert.equal(report.summary.movements, 3);
});

test('an unknown type code is read as funding so the count and the totals agree', () => {
  // Dropping the row would make the headline count and the summed column
  // disagree, which is a worse outcome than classifying it plainly.
  const report = buildOwnerFundReport([baseRow({ kind: 'something_else' })]);

  assert.equal(report.movements.length, 1);
  assert.equal(report.movements[0].kind, 'funding');
  assert.equal(report.summary.fundedCount, 1);
  assert.equal(report.summary.totalFunded, 50000);
});

test('an empty period reports zeros rather than nothing', () => {
  const report = buildOwnerFundReport([]);

  assert.deepEqual(report.movements, []);
  assert.equal(report.summary.movements, 0);
  assert.equal(report.summary.totalFunded, 0);
  assert.equal(report.summary.totalReturned, 0);
  assert.equal(report.summary.netToAccounts, 0);
  assert.equal(report.summary.accountsTouched, 0);
  assert.equal(report.summary.settledDirectly, 0);
});

test('a malformed amount is read as zero rather than as NaN', () => {
  const report = buildOwnerFundReport([baseRow({ net_amount: 'not-a-number' as any })]);

  assert.equal(report.movements[0].amount, 0);
  assert.equal(report.summary.totalFunded, 0);
});

test('an unparseable date is reported as null rather than an invalid Date', () => {
  const report = buildOwnerFundReport([baseRow({ approved_at: 'yesterday' })]);

  assert.equal(report.movements[0].approvedAt, null);
});

test('charges recorded as numbers rather than strings are summed the same way', () => {
  const report = buildOwnerFundReport([
    baseRow({ net_amount: '1000.00', additional_charges: [{ amount: 25 }, { amount: '75.50' }] }),
  ]);

  assert.equal(report.movements[0].amount, 1100.5);
});

// A provider's interest credit is booked under the owner_funding type code
// and told apart only by its payment method. Counted here it would report the
// provider's money as the owner's and put Owner Capital at odds with the
// statement, which already files the same row as other income (2292e91).
test('a provider interest credit is not the owner money and is left out entirely', () => {
  const report = buildOwnerFundReport([
    baseRow({ payment_method: 'provider_interest', net_amount: '10.00' }),
  ]);

  assert.equal(report.movements.length, 0);
  assert.equal(report.summary.movements, 0);
  assert.equal(report.summary.fundedCount, 0);
  assert.equal(report.summary.totalFunded, 0);
  assert.equal(report.summary.netToAccounts, 0);
  assert.equal(report.summary.accountsTouched, 0);
});

// The count printed above the totals has to be the same set the totals were
// summed from, so a dropped row must take its amount with it rather than
// leaving a figure nobody can attribute.
test('a mixed period counts only the owner rows and totals the same set', () => {
  const report = buildOwnerFundReport([
    baseRow({ transaction_number: 301, net_amount: '100.00', payment_method: 'cash' }),
    baseRow({ transaction_number: 302, net_amount: '10.00', payment_method: 'provider_interest' }),
    baseRow({ transaction_number: 303, kind: 'owner_return', net_amount: '40.00', payment_method: 'gcash' }),
    baseRow({ transaction_number: 304, net_amount: '5.96', payment_method: 'provider_interest' }),
  ]);

  assert.equal(report.movements.length, 2);
  assert.deepEqual(report.movements.map((m) => m.transactionNumber), [301, 303]);
  assert.equal(report.summary.movements, 2);
  assert.equal(report.summary.totalFunded, 100);
  assert.equal(report.summary.totalReturned, 40);
  assert.equal(report.summary.netToAccounts, 60);
  assert.equal(report.summary.fundedCount, 1);
  assert.equal(report.summary.returnedCount, 1);
  // The dropped rows named accounts that the surviving rows also name, so the
  // account count must not double-count them or grow by a row that is gone.
  assert.equal(report.summary.accountsTouched, 1);
});

// Only provider_interest is excluded — an owner handing over physical cash or
// a transfer is still owner money, and refusing those would empty the report.
test('every other tender still counts as the owner money', () => {
  for (const method of ['cash', 'gcash', 'maya', 'bank_transfer', 'bank', null, undefined]) {
    const report = buildOwnerFundReport([baseRow({ payment_method: method as any })]);
    assert.equal(report.movements.length, 1, `payment_method ${String(method)} should count`);
    assert.equal(report.summary.totalFunded, 50000, `payment_method ${String(method)} should total`);
  }
});
