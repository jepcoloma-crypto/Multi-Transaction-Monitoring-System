import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReversalReport } from '../services/reversalReport';
import type { ReversalRequestSourceRow, ReversalSourceRow } from '../services/reversalReport';

const reversedTransaction = (overrides: Partial<ReversalSourceRow> = {}): ReversalSourceRow => ({
  id: 'rev-1',
  transaction_number: 68,
  amount: '2711.00',
  net_amount: '2711.00',
  additional_charges: [{ amount: 15, description: 'Home Credit' }],
  reference_number: '037406164',
  description: 'Bills payment',
  transaction_date: new Date('2026-09-25T10:47:00.000Z'),
  type_name: 'Cash Out',
  direction: 'out',
  account_name: 'Jed',
  created_by: 'admin',
  reversal_id: 'comp-1',
  reversal_number: 70,
  reversal_amount: '2726.00',
  reversed_at: new Date('2026-09-26T14:19:03.548Z'),
  reversal_description: 'Reversal: Error In Fee',
  original_entry_type: 'debit',
  reversal_entry_type: 'credit',
  ledger_amount: '2726.00',
  ledger_balance_after: '17552.00',
  request_status: null,
  reason: null,
  audit_reason: 'Error In Fee',
  requested_by: null,
  approved_by: null,
  audit_actor: 'admin',
  requested_at: null,
  decided_at: null,
  ...overrides,
});

const request = (overrides: Partial<ReversalRequestSourceRow> = {}): ReversalRequestSourceRow => ({
  id: 'req-1',
  entity_type: 'transaction',
  entity_id: 'tx-1',
  transaction_number: 84,
  account_name: 'Jed',
  status: 'approved',
  reversal_amount: '200.00',
  reason: 'DUPLICATE',
  requested_by: 'bautista',
  approved_by: 'admin',
  created_at: new Date('2026-09-27T12:59:18.731Z'),
  updated_at: new Date('2026-09-27T13:04:00.000Z'),
  ...overrides,
});

test('the original total carries the additional charges the reversal compensated', () => {
  const { reversals, summary } = buildReversalReport([reversedTransaction()], []);

  assert.equal(reversals[0].originalAmount, 2711);
  assert.equal(reversals[0].chargesAmount, 15);
  assert.equal(reversals[0].originalTotal, 2726);
  assert.equal(reversals[0].reversedAmount, 2726);
  assert.equal(reversals[0].hasCompensatingEntry, true);
  assert.equal(summary.reversedCount, 1);
  assert.equal(summary.originalTotal, 2726);
  assert.equal(summary.reversedTotal, 2726);
});

test('charges are summed as money rather than accumulated as floats', () => {
  const charges = Array.from({ length: 3 }, () => ({ amount: '0.10' }));
  const { reversals, summary } = buildReversalReport([
    reversedTransaction({ net_amount: '10.00', additional_charges: charges }),
  ], []);

  assert.equal(reversals[0].originalTotal, 10.3);
  assert.equal(summary.originalTotal, 10.3);
});

test('a malformed charge amount is ignored instead of poisoning the total', () => {
  const { reversals } = buildReversalReport([
    reversedTransaction({ net_amount: '10.00', additional_charges: [{ amount: 'abc' }, null, { fee: 5 }] }),
  ], []);

  assert.equal(reversals[0].chargesAmount, 0);
  assert.equal(reversals[0].originalTotal, 10);
});

test('the reason falls back from the request to the audit log to the reversal description', () => {
  const fromRequest = buildReversalReport([reversedTransaction({ reason: 'DUPLICATE' })], []);
  assert.equal(fromRequest.reversals[0].reason, 'DUPLICATE');

  const fromAudit = buildReversalReport([reversedTransaction({ reason: null })], []);
  assert.equal(fromAudit.reversals[0].reason, 'Error In Fee');

  const fromDescription = buildReversalReport([
    reversedTransaction({ reason: null, audit_reason: null, reversal_description: 'Reversal: WRONG INPUT' }),
  ], []);
  assert.equal(fromDescription.reversals[0].reason, 'WRONG INPUT');

  const noReason = buildReversalReport([
    reversedTransaction({ reason: null, audit_reason: null, reversal_description: null }),
  ], []);
  assert.equal(noReason.reversals[0].reason, null);
});

test('the actor prefers the approver, then the audit log, then the requester', () => {
  const approved = buildReversalReport([reversedTransaction({ approved_by: 'qa_admin', audit_actor: 'admin', requested_by: 'bautista' })], []);
  assert.equal(approved.reversals[0].reversedBy, 'qa_admin');

  const direct = buildReversalReport([reversedTransaction({ approved_by: null, audit_actor: 'admin', requested_by: null })], []);
  assert.equal(direct.reversals[0].reversedBy, 'admin');

  const requestedOnly = buildReversalReport([reversedTransaction({ approved_by: null, audit_actor: null, requested_by: 'bautista' })], []);
  assert.equal(requestedOnly.reversals[0].reversedBy, 'bautista');
});

test('a reversed transaction with no compensating entry is reported but not counted as reversed money', () => {
  const { reversals, summary } = buildReversalReport([
    reversedTransaction({
      reversal_id: null,
      reversal_number: null,
      reversal_amount: null,
      reversed_at: null,
      original_entry_type: 'credit',
      reversal_entry_type: null,
      ledger_amount: null,
      ledger_balance_after: null,
    }),
  ], []);

  assert.equal(reversals[0].hasCompensatingEntry, false);
  assert.equal(reversals[0].reversedAmount, null);
  assert.equal(reversals[0].reversalNumber, null);
  assert.equal(summary.originalTotal, 2726);
  assert.equal(summary.reversedTotal, 0);
});

test('each side reports the ledger row that recorded it rather than a guess from direction', () => {
  const cashOut = buildReversalReport([reversedTransaction()], []);
  assert.equal(cashOut.reversals[0].originalEntryType, 'debit');
  assert.equal(cashOut.reversals[0].reversalEntryType, 'credit');

  const disagrees = buildReversalReport([reversedTransaction({ direction: 'in', original_entry_type: 'credit', reversal_entry_type: 'debit' })], []);
  assert.equal(disagrees.reversals[0].originalEntryType, 'credit');
  assert.equal(disagrees.reversals[0].reversalEntryType, 'debit');

  const missing = buildReversalReport([reversedTransaction({ original_entry_type: null, reversal_entry_type: null })], []);
  assert.equal(missing.reversals[0].originalEntryType, null);
  assert.equal(missing.reversals[0].reversalEntryType, null);
});

test('integer identifiers survive as numbers whatever pg hands them over', () => {
  const asStrings = buildReversalReport([reversedTransaction({ transaction_number: '164', reversal_number: '206' })], []);
  assert.equal(asStrings.reversals[0].transactionNumber, 164);
  assert.equal(asStrings.reversals[0].reversalNumber, 206);

  const missing = buildReversalReport([reversedTransaction({ reversal_number: null })], []);
  assert.equal(missing.reversals[0].reversalNumber, null);
});

test('requests are tallied by status and only pending money is awaiting approval', () => {
  const rows = [
    request(),
    request({ id: 'req-2', status: 'pending', reversal_amount: '5500.00', reason: 'No duplicated data found', approved_by: null }),
    request({ id: 'req-3', status: 'rejected', reversal_amount: '1000.00' }),
  ];

  const report = buildReversalReport([], rows);

  assert.equal(report.summary.requestCount, 3);
  assert.equal(report.summary.approvedRequests, 1);
  assert.equal(report.summary.pendingRequests, 1);
  assert.equal(report.summary.rejectedRequests, 1);
  assert.equal(report.summary.pendingRequestAmount, 5500);
  assert.equal(report.requests.length, 3);
  assert.equal(report.requests[0].amount, 200);
  assert.equal(report.requests[0].requestedBy, 'bautista');
  assert.equal(report.requests[0].transactionNumber, 84);
});

test('money and dates arrive as numbers and ISO strings as readily as NUMERIC text', () => {
  const { reversals, requests } = buildReversalReport(
    [reversedTransaction({
      net_amount: 2711,
      reversal_amount: 2726,
      ledger_amount: 2726,
      ledger_balance_after: 17552,
      transaction_date: '2026-09-25T10:47:00.000Z',
      reversed_at: '2026-09-26T14:19:03.548Z',
    })],
    [request({ reversal_amount: 200, created_at: '2026-09-27T12:59:18.731Z', updated_at: '2026-09-27T13:04:00.000Z' })],
  );

  assert.equal(reversals[0].originalTotal, 2726);
  assert.equal(reversals[0].reversedAmount, 2726);
  assert.equal(reversals[0].ledgerAmount, 2726);
  assert.equal(reversals[0].ledgerBalanceAfter, 17552);
  assert.equal(reversals[0].transactionDate, '2026-09-25T10:47:00.000Z');
  assert.equal(reversals[0].reversedAt, '2026-09-26T14:19:03.548Z');
  assert.equal(requests[0].amount, 200);
  assert.equal(requests[0].requestedAt, '2026-09-27T12:59:18.731Z');
});

test('an unreadable date is reported as absent rather than rendered', () => {
  const { reversals } = buildReversalReport([
    reversedTransaction({
      transaction_date: 'not a date',
      reversed_at: new Date('nope'),
      requested_at: undefined,
      decided_at: 0,
    }),
  ], []);

  assert.equal(reversals[0].transactionDate, null);
  assert.equal(reversals[0].reversedAt, null);
  assert.equal(reversals[0].requestedAt, null);
  assert.equal(reversals[0].decidedAt, null);
});

test('a reversal description carrying no reason of its own stays empty', () => {
  const blank = buildReversalReport([
    reversedTransaction({ reason: null, audit_reason: null, reversal_description: 'Reversal: ' }),
  ], []);
  assert.equal(blank.reversals[0].reason, null);

  const unprefixed = buildReversalReport([
    reversedTransaction({ reason: null, audit_reason: null, reversal_description: 'Manual back-out' }),
  ], []);
  assert.equal(unprefixed.reversals[0].reason, 'Manual back-out');

  const whitespace = buildReversalReport([
    reversedTransaction({ reason: null, audit_reason: null, reversal_description: '   ' }),
  ], []);
  assert.equal(whitespace.reversals[0].reason, null);
});

test('a charge list that never arrives as an array contributes nothing', () => {
  const missing = buildReversalReport([reversedTransaction({ additional_charges: null })], []);
  assert.equal(missing.reversals[0].chargesAmount, 0);

  const serialised = buildReversalReport([reversedTransaction({ additional_charges: '[{"amount":5}]' })], []);
  assert.equal(serialised.reversals[0].chargesAmount, 0);

  const absent = buildReversalReport([reversedTransaction({ additional_charges: undefined })], []);
  assert.equal(absent.reversals[0].chargesAmount, 0);
});

test('an empty period still returns a well formed report', () => {
  const report = buildReversalReport([], []);

  assert.deepEqual(report.reversals, []);
  assert.deepEqual(report.requests, []);
  assert.deepEqual(report.summary, {
    reversedCount: 0,
    originalTotal: 0,
    reversedTotal: 0,
    requestCount: 0,
    pendingRequests: 0,
    approvedRequests: 0,
    rejectedRequests: 0,
    pendingRequestAmount: 0,
  });
});
