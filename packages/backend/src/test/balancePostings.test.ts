import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPostings } from '../services/balance';

const WALLET = 'a1a1a1a1-0000-0000-0000-000000000001';
const DRAWER = 'b2b2b2b2-0000-0000-0000-000000000002';

function expectServerError(fn: () => unknown, pattern: RegExp): void {
  let caught: any;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `expected an error matching ${pattern}, but nothing was thrown`);
  assert.equal(caught.statusCode, 500, `unexpected statusCode for: ${caught.message}`);
  assert.match(caught.message, pattern);
}

test('with no counterparty the movement writes exactly one row', () => {
  const postings = planPostings(WALLET, 'credit', 500);

  assert.deepEqual(postings, [{ accountId: WALLET, entryType: 'credit', amount: 500 }]);
});

test('the primary leg is never altered by the presence of a counterparty', () => {
  const postings = planPostings(WALLET, 'debit', 500, {
    accountId: DRAWER,
    amount: 490,
    entryType: 'debit',
  });

  assert.deepEqual(postings[0], { accountId: WALLET, entryType: 'debit', amount: 500 });
  assert.equal(postings.length, 2);
});

test('the drawer leg sits at index 1 so callers can find it without searching', () => {
  const postings = planPostings(WALLET, 'debit', 500, {
    accountId: DRAWER,
    amount: 490,
    entryType: 'debit',
  });

  assert.equal(postings[1].accountId, DRAWER);
});

test('a cash-out debits the wallet and credits the drawer — a transfer, not a shared loss', () => {
  // ₱500 leaves the account, ₱500 arrives in the drawer plus the ₱10 fee = ₱510.
  // Opposite directions, because the money moved between two pools of the same
  // company. The legs sum to the fee (D24): −500 + 510 = +10.
  const postings = planPostings(WALLET, 'debit', 500, {
    accountId: DRAWER,
    amount: 510,
    entryType: 'credit',
  });

  assert.deepEqual(postings, [
    { accountId: WALLET, entryType: 'debit', amount: 500 },
    { accountId: DRAWER, entryType: 'credit', amount: 510 },
  ]);
});

test('a cash-in credits the wallet and debits the drawer', () => {
  // ₱500 lands in the account, ₱500 leaves the drawer, ₱10 comes back as
  // income, so the drawer is down ₱490. The legs sum to the fee: +500 − 490 = +10.
  const postings = planPostings(WALLET, 'credit', 500, {
    accountId: DRAWER,
    amount: 490,
    entryType: 'debit',
  });

  assert.deepEqual(postings, [
    { accountId: WALLET, entryType: 'credit', amount: 500 },
    { accountId: DRAWER, entryType: 'debit', amount: 490 },
  ]);
});

test('a zero-amount counterparty writes no second row', () => {
  const postings = planPostings(WALLET, 'credit', 500, {
    accountId: DRAWER,
    amount: 0,
    entryType: 'credit',
  });

  assert.equal(postings.length, 1);
});

test('the counterparty may not be the primary account', () => {
  expectServerError(
    () => planPostings(WALLET, 'credit', 500, { accountId: WALLET, amount: 10, entryType: 'credit' }),
    /different account/
  );
});

test('a missing counterparty account id is refused', () => {
  expectServerError(
    () => planPostings(WALLET, 'credit', 500, { accountId: '', amount: 10, entryType: 'credit' }),
    /Counterparty account id is required/
  );
});

test('a negative counterparty amount is refused', () => {
  // Amounts are magnitudes here, the same convention updateAccountBalance relies on.
  // A negative one would credit where the caller meant to debit.
  expectServerError(
    () => planPostings(WALLET, 'credit', 500, { accountId: DRAWER, amount: -10, entryType: 'credit' }),
    /non-negative finite number/
  );
});

test('a non-finite counterparty amount is refused', () => {
  expectServerError(
    () => planPostings(WALLET, 'credit', 500, { accountId: DRAWER, amount: NaN, entryType: 'credit' }),
    /non-negative finite number/
  );
  expectServerError(
    () => planPostings(WALLET, 'credit', 500, { accountId: DRAWER, amount: Infinity, entryType: 'credit' }),
    /non-negative finite number/
  );
});
