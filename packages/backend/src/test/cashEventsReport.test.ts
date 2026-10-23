// R2 — Cash Events: the six things the module's cash-event form records, plus
// `adjustment_in`, which is not offered on that form and exists only as the
// counter-row a reversal posts.
//
// That last fact is the whole reason this report classifies rows rather than
// trusting a code list: on 2026-10-19 two reversed cash-ins posted their unwind
// as `adjustment_out` transactions (probed live). A report that read
// `txn_code = 'adjustment_out'` as "a manual adjustment" would have shown the
// bookkeeping that *undid* a movement as though an operator had taken cash out
// by hand. The rows stay — the cash really did move, and the statement's
// Adjustments bucket counts them too — but they are labelled `reversal`.
//
// Pure: the route reads ledger rows, this decides what they mean.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCashEventsReport,
  CASH_EVENT_LABELS,
  CASH_EVENT_KINDS,
  isReversalRow,
  type CashEventSourceRow,
} from '../services/cashEventsReport';

const row = (overrides: Partial<CashEventSourceRow> = {}): CashEventSourceRow => ({
  branch_id: 'b1',
  branch_name: 'Main Branch',
  entry_type: 'credit',
  amount: '50000.00',
  source_type: 'transaction',
  txn_code: 'loan_received',
  payment_method: 'cash',
  transaction_id: 't1',
  transaction_number: '100',
  status: 'completed',
  reference_number: null,
  payee: 'Lender',
  description: 'Short-term loan',
  recorded_by_username: 'cashier1',
  entry_date: '2026-10-14T08:00:00Z',
  ...overrides,
});

test('every event code has a label and a direction, and none is missing', () => {
  assert.deepEqual(
    [...CASH_EVENT_KINDS].sort(),
    ['adjustment_in', 'adjustment_out', 'loan_received', 'loan_repayment', 'other_income', 'refund', 'refund_received'],
  );
  for (const kind of CASH_EVENT_KINDS) assert.ok(CASH_EVENT_LABELS[kind], `${kind} must be nameable`);
});

// The tie to Sources and Uses: borrowings net is the statement's borrowings
// bucket (received − repaid), computed from the same ledger rows.
test('borrowed, repaid and the net agree with the statement bucket', () => {
  const report = buildCashEventsReport([
    row({ id: 'a', txn_code: 'loan_received', entry_type: 'credit', amount: '50000.00' }),
    row({ id: 'b', txn_code: 'loan_repayment', entry_type: 'debit', amount: '10000.00' }),
    row({ id: 'c', txn_code: 'loan_received', entry_type: 'credit', amount: '5000.00' }),
  ]);
  assert.equal(report.summary.borrowed, 55000);
  assert.equal(report.summary.repaid, 10000);
  assert.equal(report.summary.borrowingsNet, 45000);
  assert.equal(report.summary.borrowed - report.summary.repaid, report.summary.borrowingsNet);
});

test('each kind is its own line and the lines net to the report total', () => {
  const report = buildCashEventsReport([
    row({ id: 'a', txn_code: 'loan_received', entry_type: 'credit', amount: '1000.00' }),
    row({ id: 'b', txn_code: 'refund', entry_type: 'debit', amount: '300.00' }),
    row({ id: 'c', txn_code: 'other_income', entry_type: 'credit', amount: '700.00' }),
  ]);
  const summed = report.kinds.reduce((total, k) => total + k.amount, 0);
  assert.equal(summed, report.summary.net, 'the kinds add back to the net');
  assert.equal(report.summary.net, 1400);
  const refund = report.kinds.find((k) => k.kind === 'refund');
  assert.equal(refund!.amount, -300, 'money handed out reads negative');
  assert.equal(refund!.count, 1);
});

// The 2026-10-19 regression this exists for: a reversal's counter-row carries
// `REV-<number>`, and it is bookkeeping, not somebody taking cash out.
test('a reversal counter-row is marked and counted apart from a manual event', () => {
  const report = buildCashEventsReport([
    row({ id: 'a', txn_code: 'adjustment_out', entry_type: 'debit', amount: '20.00' }),
    row({ id: 'b', txn_code: 'adjustment_out', entry_type: 'credit', amount: '20.00', transaction_number: '1234', reference_number: 'REV-1234', status: 'reversed' }),
  ]);
  const manual = report.rows.find((r) => r.id === 'a');
  const reversal = report.rows.find((r) => r.id === 'b');
  assert.equal(manual!.role, 'manual');
  assert.equal(reversal!.role, 'reversal');
  assert.equal(report.summary.manualCount, 1);
  assert.equal(report.summary.reversalCount, 1);
  assert.equal(report.summary.count, 2, 'the row is still listed — the cash really moved');
  assert.equal(report.summary.net, 0, 'and it still nets off, as the statement does');
});

test('adjustment_in is present so the adjustments bucket ties', () => {
  const report = buildCashEventsReport([
    row({ id: 'a', txn_code: 'adjustment_out', entry_type: 'debit', amount: '500.00' }),
    row({ id: 'b', txn_code: 'adjustment_in', entry_type: 'credit', amount: '500.00', transaction_number: '99', reference_number: 'REV-99' }),
  ]);
  const kinds = new Set(report.kinds.map((k) => k.kind));
  assert.ok(kinds.has('adjustment_in'), 'the counter-code is reported too');
  assert.ok(kinds.has('adjustment_out'));
  assert.equal(report.summary.net, 0, 'the pair is worth nothing, exactly as the bucket says');
});

test('isReversalRow recognises the reversal reference and nothing else', () => {
  assert.equal(isReversalRow({ reference_number: 'REV-49690', transaction_number: '49690' }), true);
  assert.equal(isReversalRow({ reference_number: 'OR-49690', transaction_number: '49690' }), false);
  assert.equal(isReversalRow({ reference_number: 'REV-999', transaction_number: '49690' }), false,
    'a reference naming a different transaction is not this row\'s reversal');
  assert.equal(isReversalRow({ reference_number: null }), false);
  assert.equal(isReversalRow({ reference_number: 'REV-49690' }), true,
    'a row that predates the numbered column still reads as a reversal');
});

// A drawer event has no category, so what identifies it is who was paid, what
// the reference said and what was typed in the description.
test('the row carries the fields an event is read by', () => {
  const report = buildCashEventsReport([
    row({ txn_code: 'refund', entry_type: 'debit', amount: '150.00', payee: 'Juan Cruz', reference_number: 'OR-77', description: 'Refund for failed load', recorded_by_username: 'cashier2' }),
  ]);
  const [listed] = report.rows;
  assert.equal(listed.payee, 'Juan Cruz');
  assert.equal(listed.referenceNumber, 'OR-77');
  assert.equal(listed.description, 'Refund for failed load');
  assert.equal(listed.recordedBy, 'cashier2');
  assert.equal(listed.direction, 'out');
  assert.equal(listed.label, 'Refund paid out');
});

test('rows are newest first and the day is the day the operator worked', () => {
  const report = buildCashEventsReport([
    row({ id: 'old', entry_date: '2026-10-14T08:00:00Z' }),
    row({ id: 'new', entry_date: '2026-10-20T08:00:00Z' }),
  ]);
  assert.deepEqual(report.rows.map((r) => r.id), ['new', 'old']);
  assert.ok(report.rows.every((r) => typeof r.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day)),
    'the day is a date key, not an instant');
});

// The service could have fallen back to today's date the way `eventDateKey`
// does, which is right for stamping a new event and wrong for a report row: an
// unreadable date would file an old cash event under today and move it into the
// period the operator was reading.
test('a row with no readable date is blank rather than filed under today', () => {
  const report = buildCashEventsReport([
    row({ id: 'a', txn_code: 'other_income', entry_date: 'not-a-date' }),
    row({ id: 'b', txn_code: 'other_income', entry_date: null }),
  ]);
  assert.deepEqual(report.rows.map((r) => r.day), [null, null]);
});

test('no rows still produces a report with zeros, never undefined', () => {
  const report = buildCashEventsReport([]);
  assert.deepEqual(report.rows, []);
  assert.deepEqual(report.kinds, []);
  assert.equal(report.summary.net, 0);
  assert.equal(report.summary.borrowed, 0);
  assert.equal(report.summary.repaid, 0);
  assert.equal(report.summary.borrowingsNet, 0);
  assert.equal(report.summary.count, 0);
});

test('centavos, not floats', () => {
  const report = buildCashEventsReport([
    row({ id: 'a', txn_code: 'other_income', entry_type: 'credit', amount: '0.10' }),
    row({ id: 'b', txn_code: 'other_income', entry_type: 'credit', amount: '0.05' }),
  ]);
  assert.equal(report.summary.net, 0.15);
});
