import test from 'node:test';
import assert from 'node:assert/strict';
import { statementReversal, type StatementReversalRow } from '../services/statementReversal';

const row = (overrides: Partial<StatementReversalRow> = {}): StatementReversalRow => ({
  reference_number: '5045409564089',
  description: null,
  transaction_id: 'tx-b',
  transaction_number: 83,
  transaction_status: 'completed',
  transfer_status: null,
  type_name: 'Cash-Out',
  reversal_request_reason: null,
  reversal_audit_reason: null,
  reversal_entry_description: null,
  reverses_id: null,
  reverses_number: null,
  reverses_type_name: null,
  ...overrides,
});

test('an ordinary movement is neither side of a reversal and keeps its own status', () => {
  const view = statementReversal(row());

  assert.equal(view.isReversed, false);
  assert.equal(view.isCompensating, false);
  assert.equal(view.status, 'completed');
  assert.equal(view.resolvesTo, null);
  assert.equal(view.ofNumber, null);
  assert.equal(view.reason, null);
  assert.equal(view.reference, null);
  assert.equal(view.label, null);
  assert.equal(view.typeDisplay, 'Cash-Out');
});

test('the original carries the reason the reversal recorded and points at the entry that undid it', () => {
  const view = statementReversal(row({
    transaction_status: 'reversed',
    reversal_request_reason: 'DUPLICATE',
    reverses_id: null,
  }));

  assert.equal(view.isReversed, true);
  assert.equal(view.status, 'reversed');
  assert.equal(view.reason, 'DUPLICATE');
  assert.equal(view.resolvesTo, 'tx-b');
  assert.equal(view.ofNumber, 83);
});

test('a TRANSFER has no transaction_status and falls back to the transfer status', () => {
  const view = statementReversal(row({ transaction_status: null, transfer_status: 'completed', transaction_id: null, type_name: null }));

  assert.equal(view.status, 'completed');
  assert.equal(view.isReversed, false);
});

test('the compensating entry is recognised by its REV reference and names what it reversed', () => {
  const view = statementReversal(row({
    reference_number: 'REV-83',
    description: 'Reversal: DUPLICATE',
    transaction_id: 'tx-rev',
    transaction_number: 178,
    transaction_status: 'completed',
    type_name: 'Adjustment In',
    reverses_id: 'tx-b',
    reverses_number: 83,
    reverses_type_name: 'Cash-Out',
  }));

  assert.equal(view.isCompensating, true);
  assert.equal(view.isReversed, false);
  assert.equal(view.status, 'reversal');
  assert.equal(view.reason, 'DUPLICATE');
  assert.equal(view.resolvesTo, 'tx-b');
  assert.equal(view.ofNumber, 83);
  assert.equal(view.reference, 'REV-83');
  assert.equal(view.label, 'Reversal of Cash-Out #83');
});

test('a REV reference that resolves to nothing is not treated as a reversal', () => {
  const view = statementReversal(row({
    reference_number: 'REV-83',
    description: 'Reversal: DUPLICATE',
    reverses_id: null,
    reverses_number: null,
  }));

  assert.equal(view.isCompensating, false);
  assert.equal(view.status, 'completed');
  assert.equal(view.resolvesTo, null);
  assert.equal(view.label, null);
  assert.equal(view.reference, null);
});

test('a reference merely shaped like a reversal does not become one', () => {
  const view = statementReversal(row({ reference_number: 'REV-ABC', description: 'Reversal: something' }));

  assert.equal(view.isCompensating, false);
  assert.equal(view.resolvesTo, null);
  assert.equal(view.reason, null);
});

test('the compensating entry takes its reason from its own description, not the trail joins', () => {
  const view = statementReversal(row({
    reference_number: 'REV-83',
    description: 'Reversal: wrong charge',
    reverses_id: 'tx-b',
    reverses_number: 83,
  }));

  assert.equal(view.reason, 'wrong charge');
});

test('identifiers survive as numbers whatever pg hands them over', () => {
  const view = statementReversal(row({
    reference_number: 'REV-83',
    reverses_id: 'tx-b',
    reverses_number: '83',
    transaction_number: '178',
  }));

  assert.equal(view.ofNumber, 83);
  assert.equal(view.label, 'Reversal of Transaction #83');

  const missing = statementReversal(row({ transaction_status: 'reversed', transaction_number: null }));
  assert.equal(missing.ofNumber, null);

  const blank = statementReversal(row({ transaction_status: 'reversed', transaction_number: '' }));
  assert.equal(blank.ofNumber, null);

  const nonNumeric = statementReversal(row({ transaction_status: 'reversed', transaction_number: 'not-a-number' }));
  assert.equal(nonNumeric.ofNumber, null);

  const alreadyNumeric = statementReversal(row({ transaction_status: 'reversed', transaction_number: 83 }));
  assert.equal(alreadyNumeric.ofNumber, 83);

  const infinite = statementReversal(row({ transaction_status: 'reversed', transaction_number: Number.POSITIVE_INFINITY }));
  assert.equal(infinite.ofNumber, null);
});