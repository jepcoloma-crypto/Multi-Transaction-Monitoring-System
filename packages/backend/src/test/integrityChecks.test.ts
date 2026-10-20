import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkTillHoldsItsIncome,
  checkFeeRowPlacement,
  checkNetAmountConsistency,
  feeRowSide,
  runIntegrityChecks,
  type TillIncomeRow,
  type FeePlacementRow,
  type NetAmountRow,
} from '../services/integrityChecks';

// The three checks are pure, so every case here is the exact shape a row held in
// production. The first group is the regression that matters: transactions 3 and
// 21 as they stood on 2026-10-19, before the re-post — the ₱20 that no internal
// invariant could see, because D24 held on both rows and the books were
// internally perfect while saying the wrong thing about who owned the fee.

const base = {
  referenceNumber: '13006',
  direction: 'in',
  amount: 300,
  fee: 10,
  feeAddedToBalance: true,
  status: 'completed',
};

// --- check 1: the till holds what income says it earned ------------------

test('the ₱20 that started this is named by check 1', () => {
  // Transaction 3 before the re-post: income booked ₱10 as the till's, and the
  // till's rows carried nothing — the fee had been credited to the e-wallet.
  const rows: TillIncomeRow[] = [
    { ...base, transactionNumber: 3, drawerFeeNet: 0, hasDrawerRows: true },
    { ...base, transactionNumber: 21, referenceNumber: '50164', amount: 500, drawerFeeNet: 0, hasDrawerRows: true },
  ];

  const check = checkTillHoldsItsIncome(rows);

  assert.equal(check.status, 'findings');
  assert.equal(check.checked, 2);
  assert.equal(check.findings.length, 2);
  assert.deepEqual(check.findings.map((f) => f.transactionNumber), [3, 21]);
  assert.equal(check.findings[0].expected, 10);
  assert.equal(check.findings[0].actual, 0);
  assert.match(check.summary, /₱20\.00 apart/);
});

test('after the re-post the same two rows pass, because a correction counts', () => {
  // The drawer now holds a `Fee correction:` credit of ₱10; the account's
  // original `Service fee` is cancelled by a matching debit. Netting is what
  // makes the correction visible — counting fee rows would not.
  const rows: TillIncomeRow[] = [
    { ...base, transactionNumber: 3, drawerFeeNet: 10, hasDrawerRows: true },
    { ...base, transactionNumber: 21, referenceNumber: '50164', amount: 500, drawerFeeNet: 10, hasDrawerRows: true },
  ];

  const check = checkTillHoldsItsIncome(rows);
  assert.equal(check.status, 'pass');
  assert.equal(check.findings.length, 0);
  assert.equal(check.checked, 2);
  assert.match(check.summary, /₱20\.00/);
});

test('a fee the report does not book for the till is out of scope entirely', () => {
  // A fee carved from the amount belongs to the receiving account, and the
  // income report never claims it for the tin — so it is not this check's to
  // verify. Counting it would report a false gap on every cash-in of its kind.
  const rows: TillIncomeRow[] = [
    { ...base, transactionNumber: 4, feeAddedToBalance: false, fee: 30, drawerFeeNet: 0, hasDrawerRows: true },
  ];

  const check = checkTillHoldsItsIncome(rows);
  assert.equal(check.status, 'pass');
  assert.equal(check.checked, 0);
});

test('a movement with no drawer rows at all is a finding, not a silent pass', () => {
  // An inner join on ledger rows would leave this movement out of the list
  // entirely, and it would pass by never being asked (design IC6).
  const rows: TillIncomeRow[] = [
    { ...base, transactionNumber: 9, drawerFeeNet: 0, hasDrawerRows: false },
  ];

  const check = checkTillHoldsItsIncome(rows);
  assert.equal(check.status, 'findings');
  assert.equal(check.findings.length, 1);
  assert.match(check.findings[0].detail, /no drawer row at all/);
});

test('a reversal and a pending movement are not judged', () => {
  const rows: TillIncomeRow[] = [
    { ...base, transactionNumber: 1, status: 'reversed', drawerFeeNet: 0, hasDrawerRows: true },
    { ...base, transactionNumber: 2, status: 'pending', drawerFeeNet: 0, hasDrawerRows: true },
  ];

  const check = checkTillHoldsItsIncome(rows);
  assert.equal(check.status, 'pass');
  assert.equal(check.checked, 0);
});

test('a till that carries more than the booked fee is reported too', () => {
  const rows: TillIncomeRow[] = [
    { ...base, transactionNumber: 12, drawerFeeNet: 25, hasDrawerRows: true },
  ];

  const check = checkTillHoldsItsIncome(rows);
  assert.equal(check.status, 'findings');
  assert.equal(check.findings[0].expected, 10);
  assert.equal(check.findings[0].actual, 25);
  assert.match(check.findings[0].detail, /carry ₱25\.00 against a booked fee of ₱10\.00/);
});

// --- check 2: the fee's row sits where its mode says ---------------------

test('feeRowSide names the drawer for a cash-out under either mode', () => {
  assert.equal(feeRowSide('out', true), 'drawer');
  assert.equal(feeRowSide('out', false), 'drawer');
  assert.equal(feeRowSide('in', true), 'drawer');
  assert.equal(feeRowSide('in', false), 'account');
  assert.equal(feeRowSide('adjustment', true), 'drawer');
});

test('both cash-in modes place the fee row, and each on its own side', () => {
  const rows: FeePlacementRow[] = [
    // Fee cut from the amount: the receiving account carries the fee's row.
    { ...base, transactionNumber: 4, fee: 30, feeAddedToBalance: false, accountFeeNet: 30, drawerFeeNet: 0 },
    // Fee collected on top: the till carries it.
    { ...base, transactionNumber: 3, accountFeeNet: 0, drawerFeeNet: 10 },
  ];

  const check = checkFeeRowPlacement(rows);
  assert.equal(check.status, 'pass');
  assert.equal(check.checked, 2);
});

test('the backwards tender flag is caught even though the pesos match', () => {
  // This is the D46 blind spot closed. A cash-in posted the old way lands the
  // amount on the account either way, so the account total cannot tell the two
  // cells apart and `classifyFeeMovement` reads ok. The fee's *row* can: it is
  // sitting on the account while the flag says the till collected it.
  const rows: FeePlacementRow[] = [
    { ...base, transactionNumber: 3, accountFeeNet: 10, drawerFeeNet: 0 },
  ];

  const check = checkFeeRowPlacement(rows);
  assert.equal(check.status, 'findings');
  assert.equal(check.findings.length, 1);
  assert.equal(check.findings[0].actual, 0);
  assert.match(check.findings[0].detail, /collected on top/);
  assert.match(check.findings[0].detail, /belongs in the till/);
});

test('the placement message reports pesos, not a hundredth of them', () => {
  // Transaction 44 (reference 59724): a cash-in whose fee now reads as cut from
  // the amount while the till still holds its row. The figures in this message
  // are what an operator reads to decide where the money is, and they were
  // being divided by a second time — a ₱10.00 fee reported as ₱0.10, in the
  // one sentence naming the discrepancy. Check 1's figures are summed in cents
  // and do divide, which is what made dividing look right here.
  const rows: FeePlacementRow[] = [
    { ...base, transactionNumber: 44, referenceNumber: '59724', feeAddedToBalance: false, accountFeeNet: 0, drawerFeeNet: 10 },
  ];

  const check = checkFeeRowPlacement(rows);
  assert.equal(check.status, 'findings');
  assert.match(check.findings[0].detail, /the till carries ₱10\.00 and the account ₱0\.00/);
});

test('a corrected movement passes placement, because the sides net to one', () => {
  // After a re-post both sides hold a ₱10 row — the original fee on the account
  // and the correction in the till. Only the net says where it finally landed,
  // so counting fee rows instead of netting them would flag every fixed row.
  const rows: FeePlacementRow[] = [
    { ...base, transactionNumber: 3, accountFeeNet: 0, drawerFeeNet: 10 },
  ];

  const check = checkFeeRowPlacement(rows);
  assert.equal(check.status, 'pass');
});

test('a cash-out whose fee never reached the till is a finding', () => {
  const rows: FeePlacementRow[] = [
    { ...base, transactionNumber: 6, direction: 'out', amount: 2500, fee: 30, accountFeeNet: 0, drawerFeeNet: 0 },
  ];

  const check = checkFeeRowPlacement(rows);
  assert.equal(check.status, 'findings');
  assert.match(check.findings[0].detail, /belongs in the till/);
});

// --- check 3: net_amount is what the account's rows sum to ----------------

test('net_amount is compared against the magnitude, since a debit sums negative', () => {
  // Found by running the check before trusting it: without the absolute value
  // this reported thirty findings against perfectly correct books.
  const rows: NetAmountRow[] = [
    { transactionNumber: 6, referenceNumber: '60001', direction: 'out', amount: 2500, fee: 30, netAmount: 2500, additionalCharges: 0, status: 'completed', accountNet: -2500, hasAccountRows: true },
  ];

  const check = checkNetAmountConsistency(rows);
  assert.equal(check.status, 'pass');
});

test('a record and its rows driven apart is named', () => {
  // An amount correction that moved the record without moving the ledger.
  const rows: NetAmountRow[] = [
    { transactionNumber: 8, referenceNumber: '80002', direction: 'in', amount: 100, fee: 0, netAmount: 150, additionalCharges: 0, status: 'completed', accountNet: 100, hasAccountRows: true },
  ];

  const check = checkNetAmountConsistency(rows);
  assert.equal(check.status, 'findings');
  assert.equal(check.findings[0].expected, 150);
  assert.equal(check.findings[0].actual, 100);
  assert.match(check.findings[0].detail, /no longer matches/);
});

test('a completed record that wrote no rows at all is a finding', () => {
  const rows: NetAmountRow[] = [
    { transactionNumber: 11, referenceNumber: '11003', direction: 'in', amount: 500, fee: 0, netAmount: 500, additionalCharges: 0, status: 'completed', accountNet: 0, hasAccountRows: false },
  ];

  const check = checkNetAmountConsistency(rows);
  assert.equal(check.status, 'findings');
  assert.match(check.findings[0].detail, /wrote no rows/);
});

test('a movement that billed an additional charge is not a finding', () => {
  // Transaction 106 (reference 58327), on the books as they stood: a ₱988.00
  // bill payment with a ₱12.00 Converge charge billed on top. The customer's
  // account was debited ₱1,000.00 — net_amount plus the charge — because that
  // is what creation posts (amountFields: `netAmount + charges`) and what every
  // reversal moves (`movementTotalOf`, "the figure every reversal path moves").
  // Judging the stored figure against the rows alone named three perfectly
  // correct books as disagreements: the charge was never folded in, so every
  // movement carrying one was a guaranteed false positive.
  const rows: NetAmountRow[] = [
    { transactionNumber: 106, referenceNumber: '58327', direction: 'out', amount: 988, fee: 10, netAmount: 988, additionalCharges: 12, status: 'completed', accountNet: -1000, hasAccountRows: true },
  ];

  const check = checkNetAmountConsistency(rows);
  assert.equal(check.status, 'pass');
});

test('a charge-bearing movement whose rows still disagree is still a finding', () => {
  // The other half of the fix, or it would be no fix at all: folding the
  // charges in must not blind the check. Here the record bills ₱15.00 of
  // charges but its account moved only the bare amount, so the two still
  // disagree by exactly that much.
  const rows: NetAmountRow[] = [
    { transactionNumber: 110, referenceNumber: '07193', direction: 'out', amount: 3119, fee: 40, netAmount: 3119, additionalCharges: 15, status: 'completed', accountNet: -3119, hasAccountRows: true },
  ];

  const check = checkNetAmountConsistency(rows);
  assert.equal(check.status, 'findings');
  assert.equal(check.findings[0].expected, 3134);
  assert.equal(check.findings[0].actual, 3119);
});

// --- the whole run --------------------------------------------------------

test('a clean book passes every check, which is the point', () => {
  // Quiet when right, loud when wrong. A utility that always reports something
  // trains its reader to ignore it, so the passing case is the one that has to
  // hold: 39 fee-bearing movements, all on the side their tender names.
  const checks = runIntegrityChecks(
    [
      { ...base, transactionNumber: 3, drawerFeeNet: 10, hasDrawerRows: true },
      { ...base, transactionNumber: 21, referenceNumber: '50164', amount: 500, drawerFeeNet: 10, hasDrawerRows: true },
      { ...base, transactionNumber: 4, fee: 30, feeAddedToBalance: false, drawerFeeNet: 0, hasDrawerRows: true },
      { ...base, transactionNumber: 6, direction: 'out', amount: 2500, fee: 30, drawerFeeNet: 30, hasDrawerRows: true },
    ],
    [
      { ...base, transactionNumber: 3, accountFeeNet: 0, drawerFeeNet: 10 },
      { ...base, transactionNumber: 21, referenceNumber: '50164', amount: 500, accountFeeNet: 0, drawerFeeNet: 10 },
      { ...base, transactionNumber: 4, fee: 30, feeAddedToBalance: false, accountFeeNet: 30, drawerFeeNet: 0 },
      { ...base, transactionNumber: 6, direction: 'out', amount: 2500, fee: 30, accountFeeNet: 0, drawerFeeNet: 30 },
    ],
    [
      { transactionNumber: 3, referenceNumber: '13006', direction: 'in', amount: 300, fee: 10, netAmount: 300, additionalCharges: 0, status: 'completed', accountNet: 300, hasAccountRows: true },
      { transactionNumber: 6, referenceNumber: '60001', direction: 'out', amount: 2500, fee: 30, netAmount: 2500, additionalCharges: 0, status: 'completed', accountNet: -2500, hasAccountRows: true },
    ]
  );

  assert.equal(checks.length, 3);
  assert.ok(checks.every((c) => c.status === 'pass'), JSON.stringify(checks, null, 2));
  assert.ok(checks.every((c) => c.findings.length === 0));
});

test('one bad movement surfaces in the checks that can see it', () => {
  // The shape of the actual incident: the fee sits on the wrong side, and the
  // two checks that compare across subsystems both say so. The net_amount check
  // stays quiet, correctly — a backwards row is consistent with its own column.
  const bad = { ...base, transactionNumber: 3 };
  const checks = runIntegrityChecks(
    [{ ...bad, drawerFeeNet: 0, hasDrawerRows: true }],
    [{ ...bad, accountFeeNet: 10, drawerFeeNet: 0 }],
    [{ transactionNumber: 3, referenceNumber: '13006', direction: 'in', amount: 300, fee: 10, netAmount: 310, additionalCharges: 0, status: 'completed', accountNet: 310, hasAccountRows: true }]
  );

  assert.equal(checks[0].status, 'findings');
  assert.equal(checks[1].status, 'findings');
  assert.equal(checks[2].status, 'pass');
  assert.deepEqual(checks.map((c) => c.status), ['findings', 'findings', 'pass']);
});

test('every check states what it asserts, so a reader can disagree with it', () => {
  const checks = runIntegrityChecks([], [], []);
  for (const c of checks) {
    assert.ok(c.title.length > 0, `${c.id} has no title`);
    assert.ok(c.states.length > 0, `${c.id} does not state its assertion`);
    assert.ok(c.summary.length > 0, `${c.id} has no summary`);
  }
});
