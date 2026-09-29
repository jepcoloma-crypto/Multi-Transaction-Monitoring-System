import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateCorrection } from '../services/correctionPreview';
import type { LedgerAuditAccount, LedgerAuditEntry } from '../services/ledgerAudit';
import type { LedgerRowRef } from '../services/ledgerQuery';

const SOURCE = '00000000-0000-0000-0000-000000000099';

const account = (id: string, opening: number, current: number): LedgerAuditAccount => ({
  id,
  name: `account-${id}`,
  status: 'active',
  opening_balance: opening,
  current_balance: current,
});

const entry = (id: string, accountId: string, overrides: Partial<LedgerAuditEntry> = {}): LedgerAuditEntry => ({
  id,
  account_id: accountId,
  entry_type: 'credit',
  amount: '0.00',
  balance_after: '0.00',
  source_id: SOURCE,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const row = (id: string, accountId: string, entryType: string, amount: string): LedgerRowRef => ({
  id,
  account_id: accountId,
  entry_type: entryType,
  amount,
  balance_after: '0.00',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
});

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second));

// opening 1000 + 100 + 100 + 121 = 1321, with the middle row under correction.
const threeRowFixture = () => ({
  accounts: [account('a1', 1000, 1321)],
  entries: [
    entry('e3', 'a1', { amount: '121.00', balance_after: '1321.00', created_at: at(2) }),
    entry('e1', 'a1', { amount: '100.00', balance_after: '1100.00', created_at: at(0) }),
    entry('e2', 'a1', { amount: '100.00', balance_after: '1200.00', created_at: at(1) }),
  ],
  rows: [row('e2', 'a1', 'credit', '100.00')],
});

test('raising a credit moves the balance up and the account still reconciles', () => {
  const { accounts, entries, rows } = threeRowFixture();
  const sim = simulateCorrection(accounts, entries, rows, { a1: 150 });

  assert.equal(sim.changes.length, 1);
  assert.equal(sim.changes[0].balanceDelta, 5000);
  assert.deepEqual(sim.balances, [{ accountId: 'a1', before: 1321, after: 1371 }]);
  assert.deepEqual(sim.problems, []);

  const acc = sim.affectedAccountsAfter[0];
  assert.equal(acc.netMovement, 371);
  assert.equal(acc.expectedBalance, 1371);
  assert.equal(acc.currentBalance, 1371);
  assert.equal(acc.gap, 0);
  assert.equal(acc.chainBreaks, 0);
  assert.equal(acc.lastLedgerBalance, 1371);
  assert.equal(acc.reconciled, true);
});

test('the chain shifts from the corrected row onward, leaving earlier rows untouched', () => {
  const { accounts, entries, rows } = threeRowFixture();
  const sim = simulateCorrection(accounts, entries, rows, { a1: 150 });

  assert.deepEqual(sim.ledgerRows, [
    { id: 'e2', accountId: 'a1', amountAfter: 150, balanceAfter: 1250 },
  ]);

  // e1 keeps 1100 and e3 lands on 1371 — if the shift started any earlier or
  // stopped any later, the chain check above would break instead of passing.
  const acc = sim.affectedAccountsAfter[0];
  assert.equal(acc.chainBreaks, 0);
  assert.equal(acc.gap, 0);
});

test('rows are ordered by write order regardless of input order', () => {
  const { accounts, entries, rows } = threeRowFixture();
  const forward = simulateCorrection(accounts, entries, rows, { a1: 150 });
  const reversed = simulateCorrection(accounts, [...entries].reverse(), rows, { a1: 150 });

  assert.deepEqual(reversed.ledgerRows, forward.ledgerRows);
  assert.deepEqual(
    reversed.affectedAccountsAfter.map((a) => [a.chainBreaks, a.gap]),
    forward.affectedAccountsAfter.map((a) => [a.chainBreaks, a.gap])
  );
});

test('raising a debit reduces the balance', () => {
  const accounts = [account('a1', 1000, 900)];
  const entries = [entry('e1', 'a1', { entry_type: 'debit', amount: '100.00', balance_after: '900.00' })];
  const rows = [row('e1', 'a1', 'debit', '100.00')];

  const sim = simulateCorrection(accounts, entries, rows, { a1: 150 });

  assert.equal(sim.changes[0].balanceDelta, -5000);
  assert.deepEqual(sim.balances, [{ accountId: 'a1', before: 900, after: 850 }]);
  assert.equal(sim.affectedAccountsAfter[0].gap, 0);
  assert.equal(sim.affectedAccountsAfter[0].reconciled, true);
});

test('a transfer corrects both accounts in opposite directions', () => {
  const accounts = [account('a1', 1000, 900), account('a2', 5000, 10000)];
  const entries = [
    entry('e1', 'a1', { entry_type: 'debit', amount: '100.00', balance_after: '900.00' }),
    entry('e2', 'a2', { amount: '5000.00', balance_after: '10000.00', created_at: at(1) }),
  ];
  const rows = [row('e1', 'a1', 'debit', '100.00'), row('e2', 'a2', 'credit', '5000.00')];

  const sim = simulateCorrection(accounts, entries, rows, { a1: 90, a2: 4900 });

  assert.equal(sim.changes.length, 2);
  assert.deepEqual(sim.balances, [
    { accountId: 'a1', before: 900, after: 910 },
    { accountId: 'a2', before: 10000, after: 9900 },
  ]);
  assert.deepEqual(sim.problems, []);
  assert.ok(sim.affectedAccountsAfter.every((a) => a.reconciled));
  assert.ok(sim.affectedAccountsAfter.every((a) => a.gap === 0));
  assert.ok(sim.affectedAccountsAfter.every((a) => a.chainBreaks === 0));
});

test('a proposed amount that drives the balance negative is reported, not thrown', () => {
  const accounts = [account('a1', 1000, 900)];
  const entries = [entry('e1', 'a1', { entry_type: 'debit', amount: '100.00', balance_after: '900.00' })];
  const rows = [row('e1', 'a1', 'debit', '100.00')];

  const sim = simulateCorrection(accounts, entries, rows, { a1: 1500 });

  assert.equal(sim.balances[0].after, -500);
  assert.equal(sim.problems.length, 1);
  assert.match(sim.problems[0], /would fall to -500\.00/);
});

test('amounts must be an object keyed by account id', () => {
  const { accounts, entries, rows } = threeRowFixture();
  for (const bad of [150, '150', [150], null, undefined]) {
    assert.throws(
      () => simulateCorrection(accounts, entries, rows, bad),
      (e: any) => e.statusCode === 400 && /must be an object/.test(e.message),
      `accepted ${JSON.stringify(bad)}`
    );
  }
});

test('every owned account must have an amount', () => {
  const { accounts, entries, rows } = threeRowFixture();
  assert.throws(
    () => simulateCorrection(accounts, entries, rows, {}),
    (e: any) => e.statusCode === 400 && /is missing account a1/.test(e.message)
  );
});

test('an amount for an account the record does not touch is rejected', () => {
  const { accounts, entries, rows } = threeRowFixture();
  assert.throws(
    () => simulateCorrection(accounts, entries, rows, { a1: 150, a2: 10 }),
    (e: any) => e.statusCode === 400 && /does not touch: a2/.test(e.message)
  );
});

test('non-numeric and negative amounts are rejected', () => {
  const { accounts, entries, rows } = threeRowFixture();

  assert.throws(
    () => simulateCorrection(accounts, entries, rows, { a1: 'abc' }),
    (e: any) => e.statusCode === 400 && /is not a number/.test(e.message)
  );
  assert.throws(
    () => simulateCorrection(accounts, entries, rows, { a1: Number.NaN }),
    (e: any) => e.statusCode === 400 && /is not a number/.test(e.message)
  );
  assert.throws(
    () => simulateCorrection(accounts, entries, rows, { a1: -5 }),
    (e: any) => e.statusCode === 400 && /cannot be negative/.test(e.message)
  );
});

test('a no-op correction leaves the account exactly as it was', () => {
  const { accounts, entries, rows } = threeRowFixture();
  const sim = simulateCorrection(accounts, entries, rows, { a1: 100 });

  assert.equal(sim.changes[0].balanceDelta, 0);
  assert.deepEqual(sim.balances, [{ accountId: 'a1', before: 1321, after: 1321 }]);
  assert.equal(sim.affectedAccountsAfter[0].gap, 0);
  assert.equal(sim.affectedAccountsAfter[0].chainBreaks, 0);
  assert.equal(sim.affectedAccountsAfter[0].reconciled, true);
});
