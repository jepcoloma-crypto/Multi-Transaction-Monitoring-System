import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateCorrection, appendPlannedRows } from '../services/correctionPreview';
import { auditLedger } from '../services/ledgerAudit';
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

test('the correction is appended rather than rewriting the original row', () => {
  const { accounts, entries, rows } = threeRowFixture();
  const sim = simulateCorrection(accounts, entries, rows, { a1: 150 });

  assert.deepEqual(sim.corrections, [
    { accountId: 'a1', entryType: 'credit', amount: 50, balanceAfter: 1371 },
  ]);

  // Four rows, not three: the posted row keeps 100.00 and the delta is written
  // after it. An in-place edit would have left entryCount at 3 and silently
  // changed what was originally posted.
  const acc = sim.affectedAccountsAfter[0];
  assert.equal(acc.entryCount, 4);
  assert.equal(acc.gap, 0);
  assert.equal(acc.chainBreaks, 0);
});

test('rows are ordered by write order regardless of input order', () => {
  const { accounts, entries, rows } = threeRowFixture();
  const forward = simulateCorrection(accounts, entries, rows, { a1: 150 });
  const reversed = simulateCorrection(accounts, [...entries].reverse(), rows, { a1: 150 });

  assert.deepEqual(reversed.corrections, forward.corrections);
  assert.deepEqual(
    reversed.affectedAccountsAfter.map((a) => [a.chainBreaks, a.gap]),
    forward.affectedAccountsAfter.map((a) => [a.chainBreaks, a.gap])
  );
});

test('raising a debit appends an opposite-sign row and reduces the balance', () => {
  const accounts = [account('a1', 1000, 900)];
  const entries = [entry('e1', 'a1', { entry_type: 'debit', amount: '100.00', balance_after: '900.00' })];
  const rows = [row('e1', 'a1', 'debit', '100.00')];

  const sim = simulateCorrection(accounts, entries, rows, { a1: 150 });

  assert.equal(sim.changes[0].balanceDelta, -5000);
  assert.deepEqual(sim.balances, [{ accountId: 'a1', before: 900, after: 850 }]);
  assert.deepEqual(sim.corrections, [
    { accountId: 'a1', entryType: 'debit', amount: 50, balanceAfter: 850 },
  ]);

  const acc = sim.affectedAccountsAfter[0];
  assert.equal(acc.entryCount, 2);
  assert.equal(acc.gap, 0);
  assert.equal(acc.chainBreaks, 0);
  assert.equal(acc.reconciled, true);
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
  assert.deepEqual(sim.corrections, [
    { accountId: 'a1', entryType: 'credit', amount: 10, balanceAfter: 910 },
    { accountId: 'a2', entryType: 'debit', amount: 100, balanceAfter: 9900 },
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

test('a no-op correction appends nothing and leaves the account as it was', () => {
  const { accounts, entries, rows } = threeRowFixture();
  const sim = simulateCorrection(accounts, entries, rows, { a1: 100 });

  assert.equal(sim.changes[0].balanceDelta, 0);
  assert.deepEqual(sim.corrections, []);
  assert.deepEqual(sim.balances, [{ accountId: 'a1', before: 1321, after: 1321 }]);
  assert.equal(sim.affectedAccountsAfter[0].entryCount, 3);
  assert.equal(sim.affectedAccountsAfter[0].gap, 0);
  assert.equal(sim.affectedAccountsAfter[0].chainBreaks, 0);
  assert.equal(sim.affectedAccountsAfter[0].reconciled, true);
});

test('a re-entry writes a reversal and a replacement onto the same account', () => {
  const accounts = [account('a1', 1000, 1321), account('a2', 5000, 5000)];
  const entries = [entry('e1', 'a1', { amount: '321.00', balance_after: '1321.00' })];

  const applied = appendPlannedRows(accounts, entries, [
    { accountId: 'a1', entryType: 'debit', amount: 321, sourceId: SOURCE },
    { accountId: 'a2', entryType: 'credit', amount: 321, sourceId: 'new-record' },
  ]);

  assert.equal(applied.problems.length, 0);
  assert.deepEqual(
    applied.corrections.map((c) => [c.accountId, c.entryType, c.amount, c.balanceAfter]),
    [
      ['a1', 'debit', 321, 1000],
      ['a2', 'credit', 321, 5321],
    ]
  );
  assert.equal(applied.simulatedAccounts.find((a) => a.id === 'a1')!.current_balance, 1000);
  assert.equal(applied.simulatedAccounts.find((a) => a.id === 'a2')!.current_balance, 5321);

  const appended = applied.simulatedEntries.filter((e) => e.id.startsWith('planned-'));
  assert.equal(appended.length, 2);
  assert.deepEqual(appended.map((e) => e.source_id), [SOURCE, 'new-record']);
});

test('two rows that net to nothing on one account are both written and reconciled', () => {
  const accounts = [account('a1', 1000, 1321)];
  const entries = [entry('e1', 'a1', { amount: '321.00', balance_after: '1321.00' })];

  const applied = appendPlannedRows(accounts, entries, [
    { accountId: 'a1', entryType: 'credit', amount: 321, sourceId: SOURCE },
    { accountId: 'a1', entryType: 'debit', amount: 321, sourceId: 'new-record' },
  ]);

  assert.equal(applied.corrections.length, 2);
  assert.equal(applied.simulatedAccounts[0].current_balance, 1321);
  assert.equal(applied.problems.length, 0);

  const after = appendPlannedRows(accounts, entries, applied.applied);
  const audit = auditLedger(after.simulatedAccounts, after.simulatedEntries);
  assert.equal(audit.accounts[0].gap, 0);
  assert.equal(audit.accounts[0].chainBreaks, 0);
  assert.equal(audit.accounts[0].reconciled, true);
  assert.equal(audit.accounts[0].entryCount, 3);
});

test('a replacement is written before the reversal when reversing first would dip negative', () => {
  // This account is the destination of a transfer whose source is being fixed:
  // it keeps the money, so it gets a reversal (debit) and a replacement (credit)
  // that net to nothing. It has already spent most of what it received, so
  // reversing first would invent a -50 row the operator never asked for.
  const accounts = [account('a1', 0, 50)];
  const entries = [
    entry('e1', 'a1', { amount: '100.00', balance_after: '100.00', created_at: at(0) }),
    entry('e2', 'a1', { entry_type: 'debit', amount: '50.00', balance_after: '50.00', created_at: at(1) }),
  ];

  const applied = appendPlannedRows(accounts, entries, [
    { accountId: 'a1', entryType: 'debit', amount: 100, sourceId: SOURCE },
    { accountId: 'a1', entryType: 'credit', amount: 100, sourceId: 'new-record' },
  ]);

  assert.equal(applied.problems.length, 0);
  assert.deepEqual(
    applied.corrections.map((c) => [c.entryType, c.balanceAfter]),
    [
      ['credit', 150],
      ['debit', 50],
    ]
  );
  assert.equal(applied.simulatedAccounts[0].current_balance, 50);
  assert.deepEqual(applied.applied.map((r) => r.sourceId), ['new-record', SOURCE]);
});

test('a balance that genuinely ends up negative is still reported', () => {
  const accounts = [account('a1', 100, 50)];
  const entries = [entry('e1', 'a1', { entry_type: 'debit', amount: '50.00', balance_after: '50.00' })];

  const applied = appendPlannedRows(accounts, entries, [
    { accountId: 'a1', entryType: 'debit', amount: 100, sourceId: SOURCE },
  ]);

  assert.equal(applied.problems.length, 1);
  assert.match(applied.problems[0], /account account-a1 would fall to -50\.00/);
});

test('applied is returned in the exact order the rows were written', () => {
  const accounts = [account('a1', 1000, 1321), account('a2', 5000, 5000)];
  const entries = [entry('e1', 'a1', { amount: '321.00', balance_after: '1321.00' })];

  const planned = [
    { accountId: 'a1', entryType: 'debit' as const, amount: 321, sourceId: SOURCE },
    { accountId: 'a2', entryType: 'credit' as const, amount: 321, sourceId: 'new-record' },
  ];
  const applied = appendPlannedRows(accounts, entries, planned);

  assert.deepEqual(applied.applied, planned);
  assert.equal(applied.applied.length, applied.corrections.length);
  assert.deepEqual(
    applied.applied.map((r) => applied.corrections.find((c) => c.accountId === r.accountId && c.amount === r.amount)!.balanceAfter),
    [1000, 5321]
  );
});
