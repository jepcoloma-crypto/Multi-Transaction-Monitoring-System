// R2 — Cash Events: the three events the module's cash-event form offers beyond
// loans and adjustments — other_income, refund_received, refund. Borrowings live
// in Borrowings & Repayments and till corrections in the Adjustments Register,
// so neither appears here: one peso, one register.
//
// The row is still classified, not trusted: the counter-rows reversals post fall
// under the adjustment codes (the adjustments register documents the R2 probe
// that found the reversed cash-ins unwinding as adjustment_out), but a row that
// reaches this report carrying a `REV-<number>` reference is still marked
// `reversal` rather than counted as a manual event.
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
  txn_code: 'other_income',
  payment_method: 'cash',
  transaction_id: 't1',
  transaction_number: '100',
  status: 'completed',
  reference_number: null,
  payee: 'Juan Cruz',
  description: 'Other income received',
  recorded_by_username: 'cashier1',
  entry_date: '2026-10-14T08:00:00Z',
  ...overrides,
});

test('every event code has a label and a direction, and none is missing', () => {
  assert.deepEqual(
    [...CASH_EVENT_KINDS].sort(),
    ['other_income', 'refund', 'refund_received'],
  );
  for (const kind of CASH_EVENT_KINDS) assert.ok(CASH_EVENT_LABELS[kind], `${kind} must be nameable`);
});

test('each kind is its own line and the lines net to the report total', () => {
  const report = buildCashEventsReport([
    row({ id: 'a', txn_code: 'other_income', entry_type: 'credit', amount: '1000.00' }),
    row({ id: 'b', txn_code: 'refund', entry_type: 'debit', amount: '300.00' }),
    row({ id: 'c', txn_code: 'refund_received', entry_type: 'credit', amount: '700.00' }),
  ]);
  const summed = report.kinds.reduce((total, k) => total + k.amount, 0);
  assert.equal(summed, report.summary.net, 'the kinds add back to the net');
  assert.equal(report.summary.net, 1400);
  const refund = report.kinds.find((k) => k.kind === 'refund');
  assert.equal(refund!.amount, -300, 'money handed out reads negative');
  assert.equal(refund!.count, 1);
});

test('a reversal counter-row is marked and counted apart from a manual event', () => {
  const report = buildCashEventsReport([
    row({ id: 'a', txn_code: 'other_income', entry_type: 'credit', amount: '20.00' }),
    row({ id: 'b', txn_code: 'other_income', entry_type: 'debit', amount: '20.00', transaction_number: '1234', reference_number: 'REV-1234', status: 'reversed' }),
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

test('a row outside the three kinds is ignored rather than guessed at', () => {
  const report = buildCashEventsReport([
    row({ id: 'a', txn_code: 'other_income', entry_type: 'credit', amount: '500.00' }),
    row({ id: 'b', txn_code: 'adjustment_out', entry_type: 'debit', amount: '900.00' }),
    row({ id: 'c', txn_code: 'loan_received', entry_type: 'credit', amount: '100000.00' }),
  ]);
  assert.equal(report.rows.length, 1, 'only the asked-for codes are read');
  assert.equal(report.summary.net, 500);
  const kinds = new Set(report.kinds.map((k) => k.kind));
  assert.deepEqual([...kinds], ['other_income'], 'the borrowings and adjustments codes are not reported here');
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
  assert.equal(report.summary.count, 0);
  assert.equal(report.summary.manualCount, 0);
  assert.equal(report.summary.reversalCount, 0);
});

test('centavos, not floats', () => {
  const report = buildCashEventsReport([
    row({ id: 'a', txn_code: 'other_income', entry_type: 'credit', amount: '0.10' }),
    row({ id: 'b', txn_code: 'other_income', entry_type: 'credit', amount: '0.05' }),
  ]);
  assert.equal(report.summary.net, 0.15);
});
