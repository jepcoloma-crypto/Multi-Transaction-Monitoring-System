import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReEntry, RE_ENTERABLE } from '../services/reEntryPlan';
import type { LedgerRowRef } from '../services/ledgerQuery';

function row(overrides: Partial<LedgerRowRef> & { id: string; account_id: string; entry_type: string; amount: string }): LedgerRowRef {
  return {
    balance_after: '0',
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as LedgerRowRef;
}

const ORIGINAL = '11111111-1111-1111-1111-111111111111';
const NEW_ID = '22222222-2222-2222-2222-222222222222';
const ACCT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACCT_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACCT_C = 'cccccccc-0000-0000-0000-000000000003';

test('only the operator-entered record types can be re-entered', () => {
  assert.deepEqual(Object.keys(RE_ENTERABLE).sort(), ['loading', 'transaction', 'transfer']);
  assert.equal(RE_ENTERABLE.transaction, 'account');
  assert.equal(RE_ENTERABLE.transfer, 'transfer');
});

test('a transaction re-enters as a reversal on the old account plus a copy on the new one', () => {
  const rows = [row({ id: 'l1', account_id: ACCT_A, entry_type: 'credit', amount: '5050' })];

  const plan = planReEntry('transaction', rows, { accountId: ACCT_A }, { accountId: ACCT_B }, ORIGINAL, NEW_ID);

  assert.equal(plan.newAccountIds.length, 1);
  assert.equal(plan.newAccountIds[0], ACCT_B);
  assert.deepEqual(plan.moves, [{ role: 'account', from: ACCT_A, to: ACCT_B }]);

  assert.equal(plan.planned.length, 2);
  assert.deepEqual(
    plan.planned.map((p) => ({ accountId: p.accountId, entryType: p.entryType, amount: p.amount, sourceId: p.sourceId })),
    [
      { accountId: ACCT_A, entryType: 'debit', amount: 5050, sourceId: ORIGINAL },
      { accountId: ACCT_B, entryType: 'credit', amount: 5050, sourceId: NEW_ID },
    ]
  );
});

test('reversals are always planned before the replacements', () => {
  const rows = [row({ id: 'l1', account_id: ACCT_A, entry_type: 'debit', amount: '900' })];
  const plan = planReEntry('transaction', rows, { accountId: ACCT_A }, { accountId: ACCT_B }, ORIGINAL, NEW_ID);

  assert.equal(plan.planned[0].sourceId, ORIGINAL);
  assert.equal(plan.planned[1].sourceId, NEW_ID);
});

test('re-entering onto the account it already sits on is rejected', () => {
  const rows = [row({ id: 'l1', account_id: ACCT_A, entry_type: 'credit', amount: '100' })];
  assert.throws(
    () => planReEntry('transaction', rows, { accountId: ACCT_A }, { accountId: ACCT_A }, ORIGINAL, NEW_ID),
    /nothing to re-enter/i
  );
});

test('a missing target account is a bad request, not a silent no-op', () => {
  const rows = [row({ id: 'l1', account_id: ACCT_A, entry_type: 'credit', amount: '100' })];
  assert.throws(
    () => planReEntry('transaction', rows, { accountId: ACCT_A }, {}, ORIGINAL, NEW_ID),
    /accountId is required/
  );
});

test('a record with no ledger rows cannot be re-entered', () => {
  assert.throws(
    () => planReEntry('transaction', [], { accountId: ACCT_A }, { accountId: ACCT_B }, ORIGINAL, NEW_ID),
    /no ledger rows/
  );
});

test('a single-account record whose rows span accounts is refused', () => {
  const rows = [
    row({ id: 'l1', account_id: ACCT_A, entry_type: 'credit', amount: '100' }),
    row({ id: 'l2', account_id: ACCT_B, entry_type: 'credit', amount: '100' }),
  ];
  assert.throws(
    () => planReEntry('transaction', rows, { accountId: ACCT_A }, { accountId: ACCT_C }, ORIGINAL, NEW_ID),
    /more than one account/
  );
});

test('a type that is not re-enterable is refused up front', () => {
  assert.throws(() => planReEntry('reconciliation', [], {}, {}, ORIGINAL, NEW_ID), /cannot be re-entered/);
  assert.throws(() => planReEntry('adjustment', [], {}, {}, ORIGINAL, NEW_ID), /cannot be re-entered/);
});

test('a transfer maps each row by the account it sits on, not by its direction', () => {
  const rows = [
    row({ id: 'l1', account_id: ACCT_A, entry_type: 'debit', amount: '5010' }),
    row({ id: 'l2', account_id: ACCT_B, entry_type: 'credit', amount: '5000' }),
  ];
  const original = { sourceAccountId: ACCT_A, destinationAccountId: ACCT_B };

  const plan = planReEntry('transfer', rows, original, { sourceAccountId: ACCT_A, destinationAccountId: ACCT_C }, ORIGINAL, NEW_ID);

  assert.deepEqual(plan.moves, [
    { role: 'source', from: ACCT_A, to: ACCT_A },
    { role: 'destination', from: ACCT_B, to: ACCT_C },
  ]);

  const reversals = plan.planned.filter((p) => p.sourceId === ORIGINAL);
  const replacements = plan.planned.filter((p) => p.sourceId === NEW_ID);
  assert.equal(reversals.length, 2);
  assert.equal(replacements.length, 2);

  assert.deepEqual(replacements.map((p) => p.accountId).sort(), [ACCT_A, ACCT_C].sort());
  assert.deepEqual(reversals.map((p) => p.accountId).sort(), [ACCT_A, ACCT_B].sort());
});

test('a transfer that was already amount-corrected still maps by account', () => {
  const rows = [
    row({ id: 'l1', account_id: ACCT_A, entry_type: 'debit', amount: '5010' }),
    row({ id: 'l2', account_id: ACCT_B, entry_type: 'credit', amount: '5000' }),
    row({ id: 'l3', account_id: ACCT_A, entry_type: 'credit', amount: '10' }),
    row({ id: 'l4', account_id: ACCT_B, entry_type: 'debit', amount: '10' }),
  ];
  const original = { sourceAccountId: ACCT_A, destinationAccountId: ACCT_B };

  const plan = planReEntry('transfer', rows, original, { sourceAccountId: ACCT_C, destinationAccountId: ACCT_B }, ORIGINAL, NEW_ID);

  assert.deepEqual(plan.moves, [
    { role: 'source', from: ACCT_A, to: ACCT_C },
    { role: 'destination', from: ACCT_B, to: ACCT_B },
  ]);

  const replacements = plan.planned.filter((p) => p.sourceId === NEW_ID);
  assert.deepEqual(replacements.map((p) => p.accountId).sort(), [ACCT_B, ACCT_B, ACCT_C, ACCT_C].sort());
  assert.equal(replacements.filter((p) => p.accountId === ACCT_B).length, 2);
  assert.equal(replacements.some((p) => p.accountId === ACCT_A), false);
});

test('a transfer needs both sides and they must differ', () => {
  const rows = [
    row({ id: 'l1', account_id: ACCT_A, entry_type: 'debit', amount: '100' }),
    row({ id: 'l2', account_id: ACCT_B, entry_type: 'credit', amount: '100' }),
  ];
  const original = { sourceAccountId: ACCT_A, destinationAccountId: ACCT_B };

  assert.throws(
    () => planReEntry('transfer', rows, original, { sourceAccountId: ACCT_A }, ORIGINAL, NEW_ID),
    /destinationAccountId is required/
  );
  assert.throws(
    () => planReEntry('transfer', rows, original, { sourceAccountId: ACCT_A, destinationAccountId: ACCT_A }, ORIGINAL, NEW_ID),
    /must be different/
  );
});

test('a transfer with neither side unchanged re-enters both', () => {
  const rows = [
    row({ id: 'l1', account_id: ACCT_A, entry_type: 'debit', amount: '100' }),
    row({ id: 'l2', account_id: ACCT_B, entry_type: 'credit', amount: '100' }),
  ];
  const original = { sourceAccountId: ACCT_A, destinationAccountId: ACCT_B };

  assert.throws(
    () => planReEntry('transfer', rows, original, { sourceAccountId: ACCT_A, destinationAccountId: ACCT_B }, ORIGINAL, NEW_ID),
    /nothing to re-enter/i
  );
});

test('a ledger row on an account the original does not claim is refused', () => {
  const rows = [
    row({ id: 'l1', account_id: ACCT_A, entry_type: 'debit', amount: '100' }),
    row({ id: 'l2', account_id: ACCT_C, entry_type: 'credit', amount: '100' }),
  ];
  const original = { sourceAccountId: ACCT_A, destinationAccountId: ACCT_B };

  assert.throws(
    () => planReEntry('transfer', rows, original, { sourceAccountId: ACCT_A, destinationAccountId: ACCT_C }, ORIGINAL, NEW_ID),
    /does not claim/
  );
});

test('a transfer missing its own account references is refused', () => {
  const rows = [row({ id: 'l1', account_id: ACCT_A, entry_type: 'debit', amount: '100' })];
  assert.throws(
    () => planReEntry('transfer', rows, { sourceAccountId: null }, { sourceAccountId: ACCT_A, destinationAccountId: ACCT_B }, ORIGINAL, NEW_ID),
    /missing an account/
  );
});
