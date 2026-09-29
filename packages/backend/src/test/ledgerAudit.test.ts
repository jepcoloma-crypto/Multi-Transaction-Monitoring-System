import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditLedger } from '../services/ledgerAudit';
import type { LedgerAuditAccount, LedgerAuditEntry } from '../services/ledgerAudit';

const SOURCE = '00000000-0000-0000-0000-000000000099';

const account = (
  id: string,
  openingBalance: number | string,
  currentBalance: number | string,
  name = `account-${id}`
): LedgerAuditAccount => ({
  id,
  name,
  status: 'active',
  opening_balance: openingBalance,
  current_balance: currentBalance,
});

const entry = (
  id: string,
  accountId: string,
  overrides: Partial<LedgerAuditEntry> = {}
): LedgerAuditEntry => ({
  id,
  account_id: accountId,
  entry_type: 'credit',
  amount: '0.00',
  balance_after: '0.00',
  source_id: SOURCE,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

test('a consistent account reconciles with no issues', () => {
  const entries = [entry('e1', 'a1', { amount: '250.00', balance_after: '1250.00' })];
  const result = auditLedger([account('a1', 1000, 1250)], entries);
  const acc = result.accounts[0];

  assert.equal(acc.openingBalance, 1000);
  assert.equal(acc.netMovement, 250);
  assert.equal(acc.expectedBalance, 1250);
  assert.equal(acc.currentBalance, 1250);
  assert.equal(acc.gap, 0);
  assert.equal(acc.entryCount, 1);
  assert.equal(acc.chainBreaks, 0);
  assert.equal(acc.unlinkedEntries, 0);
  assert.equal(acc.lastLedgerBalance, 1250);
  assert.deepEqual(acc.issues, []);
  assert.equal(acc.reconciled, true);

  assert.deepEqual(result.summary, {
    totalAccounts: 1,
    reconciled: 1,
    mismatched: 0,
    totalGap: 0,
    brokenChainLinks: 0,
    negativeBalances: 0,
  });
});

test('a balance gap is reported and marks the account unreconciled', () => {
  const entries = [entry('e1', 'a1', { amount: '100.00', balance_after: '1100.00' })];
  const acc = auditLedger([account('a1', 1000, 900)], entries).accounts[0];

  assert.equal(acc.gap, 200);
  assert.equal(acc.issues[0], 'balance gap of 200.00');
  assert.equal(acc.reconciled, false);
});

test('an account with no ledger rows reports the whole balance as a gap', () => {
  const acc = auditLedger([account('nelia', 0, 3729)], []).accounts[0];

  assert.equal(acc.entryCount, 0);
  assert.equal(acc.lastLedgerBalance, null);
  assert.equal(acc.gap, -3729);
  assert.deepEqual(acc.issues, ['balance gap of -3729.00']);
  assert.equal(acc.reconciled, false);
});

test('a broken chain link is detected between consecutive rows', () => {
  const entries = [
    entry('e1', 'a1', { amount: '100.00', balance_after: '1100.00', created_at: new Date('2026-01-01T00:00:00Z') }),
    entry('e2', 'a1', { amount: '50.00', balance_after: '1200.00', created_at: new Date('2026-01-02T00:00:00Z') }),
  ];
  const acc = auditLedger([account('a1', 1000, 1200)], entries).accounts[0];

  assert.equal(acc.chainBreaks, 1);
  assert.ok(acc.issues.includes('1 broken chain link(s)'));
  assert.equal(acc.reconciled, false);
});

test('a negative balance_after is counted and reported', () => {
  const entries = [entry('e1', 'a1', { entry_type: 'debit', amount: '1050.00', balance_after: '-50.00' })];
  const acc = auditLedger([account('a1', 1000, -50)], entries).accounts[0];

  assert.equal(acc.negativeBalances, 1);
  assert.ok(acc.issues.includes('1 negative balance(s)'));
});

test('an unlinked row is counted without inventing an issue', () => {
  const entries = [entry('e1', 'a1', { amount: '100.00', balance_after: '1100.00', source_id: null })];
  const acc = auditLedger([account('a1', 1000, 1100)], entries).accounts[0];

  assert.equal(acc.unlinkedEntries, 1);
  assert.deepEqual(acc.issues, []);
  assert.equal(acc.reconciled, true);
});

test('a last row that disagrees with the balance is called out by name', () => {
  const entries = [entry('e1', 'a1', { amount: '100.00', balance_after: '1300.00' })];
  const acc = auditLedger([account('a1', 1000, 1100)], entries).accounts[0];

  assert.equal(acc.gap, 0);
  assert.equal(acc.chainBreaks, 0);
  assert.ok(acc.issues.includes('last ledger row 1300.00 differs from balance 1100.00'));
});

test('the chain is walked in write order, not input order', () => {
  const entries = [
    entry('e2', 'a1', { amount: '50.00', balance_after: '1150.00', created_at: new Date('2026-01-02T00:00:00Z') }),
    entry('e1', 'a1', { amount: '100.00', balance_after: '1100.00', created_at: new Date('2026-01-01T00:00:00Z') }),
  ];
  const acc = auditLedger([account('a1', 1000, 1150)], entries).accounts[0];

  assert.equal(acc.chainBreaks, 0);
  assert.equal(acc.gap, 0);
  assert.equal(acc.reconciled, true);
});

test('rows sharing a timestamp fall back to id order', () => {
  const at = new Date('2026-01-01T00:00:00Z');
  const entries = [
    entry('bbbbbbbb-0000-0000-0000-000000000002', 'a1', { amount: '50.00', balance_after: '1150.00', created_at: at }),
    entry('aaaaaaaa-0000-0000-0000-000000000001', 'a1', { amount: '100.00', balance_after: '1100.00', created_at: at }),
  ];
  const acc = auditLedger([account('a1', 1000, 1150)], entries).accounts[0];

  assert.equal(acc.chainBreaks, 0);
  assert.equal(acc.reconciled, true);
});

test('net movement sums in exact cents rather than accumulating float error', () => {
  const entries = [
    entry('e1', 'a1', { amount: '0.10', balance_after: '1000.10', created_at: new Date('2026-01-01T00:00:00Z') }),
    entry('e2', 'a1', { amount: '0.10', balance_after: '1000.20', created_at: new Date('2026-01-02T00:00:00Z') }),
    entry('e3', 'a1', { amount: '0.10', balance_after: '1000.30', created_at: new Date('2026-01-03T00:00:00Z') }),
  ];
  const acc = auditLedger([account('a1', '1000.00', '1000.30')], entries).accounts[0];

  assert.equal(acc.netMovement, 0.3);
  assert.equal(acc.expectedBalance, 1000.3);
  assert.equal(acc.gap, 0);
  assert.equal(acc.reconciled, true);
});

test('a debit reduces net movement', () => {
  const entries = [entry('e1', 'a1', { entry_type: 'debit', amount: '400.00', balance_after: '600.00' })];
  const acc = auditLedger([account('a1', 1000, 600)], entries).accounts[0];

  assert.equal(acc.netMovement, -400);
  assert.equal(acc.gap, 0);
  assert.equal(acc.reconciled, true);
});

test('entries for other accounts never bleed into this account', () => {
  const entries = [
    entry('e1', 'a1', { amount: '100.00', balance_after: '1100.00' }),
    entry('e2', 'a2', { amount: '5000.00', balance_after: '5000.00', source_id: null }),
  ];
  const result = auditLedger([account('a1', 1000, 1100), account('a2', 0, 5000)], entries);

  assert.equal(result.accounts[0].entryCount, 1);
  assert.equal(result.accounts[0].unlinkedEntries, 0);
  assert.equal(result.accounts[1].entryCount, 1);
  assert.equal(result.accounts[1].unlinkedEntries, 1);
  assert.equal(result.accounts[0].reconciled, true);
  assert.equal(result.accounts[1].reconciled, true);
});

test('the summary aggregates every account', () => {
  const entries = [
    entry('e1', 'a1', { amount: '100.00', balance_after: '1100.00', created_at: new Date('2026-01-01T00:00:00Z') }),
    entry('e2', 'a2', { amount: '50.00', balance_after: '900.00', created_at: new Date('2026-01-01T00:00:00Z') }),
    entry('e3', 'a2', { amount: '10.00', balance_after: '950.00', created_at: new Date('2026-01-02T00:00:00Z') }),
  ];
  const accounts = [account('a1', 1000, 1100), account('a2', 1000, 900)];
  const { summary } = auditLedger(accounts, entries);

  assert.deepEqual(summary, {
    totalAccounts: 2,
    reconciled: 1,
    mismatched: 1,
    totalGap: 160,
    brokenChainLinks: 1,
    negativeBalances: 0,
  });
});

test('the opening balance is not a chain link, so a lone row only shows up as a gap', () => {
  const entries = [entry('e1', 'a2', { amount: '50.00', balance_after: '900.00' })];
  const acc = auditLedger([account('a2', 1000, 900)], entries).accounts[0];

  assert.equal(acc.chainBreaks, 0);
  assert.equal(acc.gap, 150);
  assert.deepEqual(acc.issues, ['balance gap of 150.00']);
});

test('the same inputs always produce the same output', () => {
  const accounts = [account('a1', 1000, 900), account('a2', 0, 3729)];
  const entries = [entry('e1', 'a1', { amount: '100.00', balance_after: '1100.00' })];

  assert.deepEqual(auditLedger(accounts, entries), auditLedger(accounts, entries));
});
