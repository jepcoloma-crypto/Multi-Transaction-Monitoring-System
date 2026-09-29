import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORRECTION_STRATEGY, strategyFor, verifyShape } from '../services/correctionStrategy';

test('every source type the ledger accepts has a strategy', () => {
  for (const source of ['transaction', 'transfer', 'loading', 'reconciliation', 'adjustment']) {
    const strategy = strategyFor(source);
    assert.ok(strategy, `${source} is missing a strategy`);
    assert.equal(strategy.source, source);
  }
  assert.equal(strategyFor('wire'), null);
  assert.equal(strategyFor('__proto__'), null);
  assert.equal(strategyFor('toString'), null);
});

test('a transaction owns one ledger row on one account', () => {
  const strategy = CORRECTION_STRATEGY.transaction;
  assert.equal(strategy.ledgerRows, 1);
  assert.equal(strategy.accounts, 1);
  assert.equal(strategy.crossAccount, false);
  assert.equal(strategy.bidirectional, false);
  assert.equal(strategy.addressable, true);
});

test('a transfer owns two rows across two accounts in opposite directions', () => {
  const strategy = CORRECTION_STRATEGY.transfer;
  assert.equal(strategy.ledgerRows, 2);
  assert.equal(strategy.accounts, 2);
  assert.equal(strategy.crossAccount, true);
  assert.equal(strategy.bidirectional, true);
  assert.equal(strategy.addressable, true);
});

test('an unlinked balance adjustment has no source record to correct', () => {
  assert.equal(CORRECTION_STRATEGY.adjustment.addressable, false);
});

test('verifyShape accepts a well-formed single-account source', () => {
  const verdict = verifyShape(CORRECTION_STRATEGY.transaction, {
    rowCount: 1,
    accountIds: ['a1'],
    entryTypes: ['credit'],
  });
  assert.deepEqual(verdict, { ok: true, problems: [] });
});

test('verifyShape accepts a well-formed transfer', () => {
  const verdict = verifyShape(CORRECTION_STRATEGY.transfer, {
    rowCount: 2,
    accountIds: ['a1', 'a2'],
    entryTypes: ['credit', 'debit'],
  });
  assert.deepEqual(verdict, { ok: true, problems: [] });
});

test('verifyShape rejects a record that owns no ledger rows', () => {
  const verdict = verifyShape(CORRECTION_STRATEGY.transfer, { rowCount: 0, accountIds: [], entryTypes: [] });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes('no ledger rows')));
});

test('verifyShape rejects a partially-linked transfer', () => {
  const verdict = verifyShape(CORRECTION_STRATEGY.transfer, {
    rowCount: 1,
    accountIds: ['a1'],
    entryTypes: ['debit'],
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes('expected 2 ledger row(s)')));
  assert.ok(verdict.problems.some((p) => p.includes('one credit row and one debit row')));
});

test('verifyShape rejects a transfer whose two rows share one account', () => {
  const verdict = verifyShape(CORRECTION_STRATEGY.transfer, {
    rowCount: 2,
    accountIds: ['a1'],
    entryTypes: ['credit', 'debit'],
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes('expected 2 account(s)')));
});

test('verifyShape rejects a single-account source holding two rows', () => {
  const verdict = verifyShape(CORRECTION_STRATEGY.transaction, {
    rowCount: 2,
    accountIds: ['a1'],
    entryTypes: ['credit', 'debit'],
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes('expected 1 ledger row(s)')));
  assert.ok(verdict.problems.some((p) => p.includes('more than one row per account')));
});
