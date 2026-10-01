import test from 'node:test';
import assert from 'node:assert/strict';
import { statementReversal, type StatementReversalRow } from '../services/statementReversal';

const row = (overrides: Partial<StatementReversalRow> = {}): StatementReversalRow => ({
  reference_number: '5045409564089',
  description: null,
  transaction_id: 'tx-b',
  transaction_number: 83,
  transaction_reference: '5045409564089',
  transaction_status: 'completed',
  transfer_id: null,
  transfer_status: null,
  transfer_reference: null,
  loading_number: null,
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
  assert.equal(view.reference, '5045409564089');
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
  // It is not a reversal, so it must show the transaction's own reference rather
  // than the REV- shaped one that failed to resolve.
  assert.equal(view.reference, '5045409564089');
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

test('a cash row shows the transaction reference, not the ledger entry that may not have one', () => {
  const view = statementReversal(row());

  assert.equal(view.referenceDisplay, '5045409564089');
  assert.equal(view.numberDisplay, '#83');
});

test('a cash row with no reference of its own shows none rather than falling through to another table', () => {
  const view = statementReversal(row({ transaction_reference: null, reference_number: '5045409564089' }));

  assert.equal(view.referenceDisplay, null);
  // The ledger's own reference is blank on 14 cash rows, so it must not be
  // used as a substitute for the transaction's.
  assert.equal(view.referenceDisplay === '5045409564089', false);
});

test('a transfer keeps its reference and drops the number that collides with cash', () => {
  const view = statementReversal(row({
    transaction_id: null,
    transaction_number: null,
    transaction_reference: null,
    transfer_id: 'tr-22',
    transfer_reference: 'TRF-2026-000022',
    type_name: null,
  }));

  assert.equal(view.referenceDisplay, 'TRF-2026-000022');
  // The reference already carries 22, so repeating it as a bare #22 is what put
  // one number on two different records on Ma. Jessica's statement.
  assert.equal(view.numberDisplay, null);
  assert.equal(view.status, 'completed');
});

test('the reversal keeps REV-<n> so it stays distinct from the reference it undid', () => {
  const original = statementReversal(row({ transaction_status: 'reversed' }));
  const reversal = statementReversal(row({
    reference_number: 'REV-83',
    transaction_reference: 'REV-83',
    description: 'Reversal: DUPLICATE',
    transaction_id: 'tx-rev',
    transaction_number: 178,
    reverses_id: 'tx-b',
    reverses_number: 83,
    reverses_type_name: 'Cash-Out',
  }));

  assert.equal(original.referenceDisplay, '5045409564089');
  assert.equal(reversal.referenceDisplay, 'REV-83');
  // #83, #84 and #183 all carry 5045409564089, so only the REV- reference tells
  // the reversal apart from the three cash-outs sharing that number.
  assert.notEqual(reversal.referenceDisplay, original.referenceDisplay);
  assert.equal(reversal.numberDisplay, '#178');
});

test('a loading row is tagged so its number cannot be read as a cash transaction', () => {
  const view = statementReversal(row({
    reference_number: null,
    transaction_id: null,
    transaction_number: null,
    transaction_reference: null,
    transaction_status: null,
    type_name: null,
    loading_number: 13,
  }));

  // loading_transactions runs its own sequence from 6 to 22, overlapping both
  // cash and transfers, so a bare 13 would sit next to cash #13.
  assert.equal(view.numberDisplay, 'LDG-13');
  // reference_number is blank on all 17 loading rows, so there is none to show.
  assert.equal(view.referenceDisplay, null);
  assert.equal(view.isCompensating, false);
  assert.equal(view.isReversed, false);
});

test('a row with nothing behind it shows neither a number nor a reference', () => {
  const view = statementReversal(row({
    reference_number: null,
    transaction_id: null,
    transaction_number: null,
    transaction_reference: null,
    transaction_status: null,
    type_name: null,
  }));

  assert.equal(view.referenceDisplay, null);
  assert.equal(view.numberDisplay, null);
  assert.equal(view.isCompensating, false);
  assert.equal(view.isReversed, false);
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