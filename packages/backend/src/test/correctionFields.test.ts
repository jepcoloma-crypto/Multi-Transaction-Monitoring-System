import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTierA, TIER_A_FIELDS } from '../services/correctionFields';

test('a valid metadata edit produces parameterised columns and values', () => {
  const result = validateTierA('transaction', {
    reference_number: 'REF-4471',
    description: 'Wrong reference captured at the counter',
    customer_name: 'Jed Bautista',
  });

  assert.deepEqual(result.columns, ['reference_number', 'description', 'customer_name']);
  assert.deepEqual(result.values, ['REF-4471', 'Wrong reference captured at the counter', 'Jed Bautista']);
});

test('an ISO timestamp is parsed to a Date', () => {
  const result = validateTierA('transaction', { transaction_date: '2026-09-15T08:30:00.000Z' });
  assert.equal(result.columns.length, 1);
  assert.ok(result.values[0] instanceof Date);
  assert.equal((result.values[0] as Date).toISOString(), '2026-09-15T08:30:00.000Z');
});

test('null clears a nullable column', () => {
  const result = validateTierA('transfer', { notes: null });
  assert.deepEqual(result.columns, ['notes']);
  assert.deepEqual(result.values, [null]);
});

test('every supported source type has an explicit whitelist', () => {
  for (const source of ['transaction', 'transfer', 'loading']) {
    assert.ok(Object.keys(TIER_A_FIELDS[source]).length > 0, `${source} has no editable fields`);
  }
});

test('a source with no metadata whitelist is refused', () => {
  assert.throws(
    () => validateTierA('reconciliation', { notes: 'anything' }),
    (e: any) => e.statusCode === 400 && /No metadata fields are correctable/.test(e.message)
  );
  assert.throws(
    () => validateTierA('wire', { notes: 'anything' }),
    (e: any) => e.statusCode === 400 && /No metadata fields are correctable/.test(e.message)
  );
});

test('money and status columns cannot be edited as metadata', () => {
  const money = [
    ['transaction', 'amount'],
    ['transaction', 'fee'],
    ['transaction', 'net_amount'],
    ['transaction', 'status'],
    ['transaction', 'account_id'],
    ['transfer', 'transfer_amount'],
    ['transfer', 'total_source_deduction'],
    ['transfer', 'status'],
    ['loading', 'unit_price'],
    ['loading', 'profit'],
    ['loading', 'quantity'],
    ['loading', 'status'],
  ] as const;

  for (const [source, field] of money) {
    assert.throws(
      () => validateTierA(source, { [field]: 1 }),
      (e: any) => e.statusCode === 400 && /money or locked field/.test(e.message),
      `allowed ${source}.${field}`
    );
  }
});

test('an unlisted column is refused rather than passed through to SQL', () => {
  assert.throws(
    () => validateTierA('transaction', { created_by: 'someone-else' }),
    (e: any) => e.statusCode === 400 && /not an editable field/.test(e.message)
  );
  assert.throws(
    () => validateTierA('transaction', { "notes = 'x'; DROP TABLE users--": 'x' }),
    (e: any) => e.statusCode === 400 && /not an editable field/.test(e.message)
  );
});

test('malformed input shapes are refused', () => {
  for (const bad of ['reference_number', 42, null, undefined, ['reference_number']]) {
    assert.throws(
      () => validateTierA('transaction', bad),
      (e: any) => e.statusCode === 400 && /must be an object/.test(e.message),
      `accepted ${JSON.stringify(bad)}`
    );
  }
});

test('an empty field set is refused', () => {
  assert.throws(
    () => validateTierA('transaction', {}),
    (e: any) => e.statusCode === 400 && /must not be empty/.test(e.message)
  );
});

test('field values must match their declared type and length', () => {
  assert.throws(
    () => validateTierA('transaction', { description: 42 }),
    (e: any) => e.statusCode === 400 && /must be a string/.test(e.message)
  );
  assert.throws(
    () => validateTierA('transaction', { description: 'x'.repeat(4001) }),
    (e: any) => e.statusCode === 400 && /at most 4000 characters/.test(e.message)
  );
  assert.throws(
    () => validateTierA('transaction', { transaction_date: 'not-a-date' }),
    (e: any) => e.statusCode === 400 && /not a valid date/.test(e.message)
  );
  assert.throws(
    () => validateTierA('transaction', { transaction_date: 1789000000000 }),
    (e: any) => e.statusCode === 400 && /must be an ISO date string/.test(e.message)
  );
});
