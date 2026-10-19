import { describe, it, expect } from 'vitest';
import { roleLabel, isUnlabelled, laterRows, sideLabel, type MovementRow } from './movementHistory';

// txn 3 as the ledger actually holds it, taken from production on 2026-10-19:
// a 300.00 cash-in whose 10.00 fee was originally posted to Vanessa's side and
// was later re-posted to the till. Every figure below is real, because the
// interesting question for this view is not "does a fixture sort?" but "does
// the one movement that has a history read correctly?"
const txn3: MovementRow[] = [
  { id: 'r1', entryType: 'credit', amount: 10, balanceAfter: 10571.35, description: 'Service fee — Cash-In', role: 'fee', accountName: 'Vanessa Bautista', accountId: '8261f54e', createdAt: '2026-10-19T19:14:38Z' },
  { id: 'r2', entryType: 'credit', amount: 300, balanceAfter: 10871.35, description: null, role: 'movement', accountName: 'Vanessa Bautista', accountId: '8261f54e', createdAt: '2026-10-19T19:14:38Z' },
  { id: 'r3', entryType: 'debit', amount: 300, balanceAfter: 97834.66, description: null, role: 'movement', accountName: 'Revolving Fund', accountId: '915c3126', createdAt: '2026-10-19T19:14:38Z' },
  { id: 'r4', entryType: 'debit', amount: 10, balanceAfter: 39.35, description: 'Fee correction: SysAudit Found - Admin', role: 'correction', accountName: 'Vanessa Bautista', accountId: '8261f54e', createdAt: '2026-10-19T23:43:55Z' },
  { id: 'r5', entryType: 'credit', amount: 10, balanceAfter: 109631.66, description: 'Fee correction: SysAudit Found - Admin', role: 'correction', accountName: 'Revolving Fund', accountId: '915c3126', createdAt: '2026-10-19T23:43:55Z' },
];

describe('roleLabel', () => {
  it('names each of the four roles migration 048 defines', () => {
    expect(roleLabel('fee')).toBe('Service fee');
    expect(roleLabel('movement')).toBe('Movement');
    expect(roleLabel('correction')).toBe('Correction');
    expect(roleLabel('reversal')).toBe('Reversal');
  });

  // The important case. A row written before the column existed, or between the
  // migration and the code that fills it, carries NULL. Sorting it silently
  // into a bucket would hide exactly the gap the column exists to make visible.
  it('says so rather than guessing at an unlabelled row', () => {
    expect(roleLabel(null)).toBe('Unlabelled');
  });
});

describe('isUnlabelled', () => {
  it('treats only NULL as a gap, not an empty string', () => {
    expect(isUnlabelled(null)).toBe(true);
    expect(isUnlabelled('')).toBe(false);
  });
});

describe('laterRows', () => {
  it('separates the re-post from the movement it corrected', () => {
    const later = laterRows(txn3);
    expect(later.map((r) => r.id)).toEqual(['r4', 'r5']);
    expect(later.map((r) => r.amount)).toEqual([10, 10]);
  });

  // The whole reason this view exists: the two correction rows are equal and
  // opposite, so the movement reads as untouched unless the re-post is
  // surfaced as its own thing. Counting the original rows alone would say
  // nothing happened here.
  it('finds the history of the one movement that has one', () => {
    expect(laterRows(txn3)).toHaveLength(2);
    expect(laterRows(txn3.slice(0, 3))).toHaveLength(0);
  });

  it('treats a reversal as history rather than as the movement itself', () => {
    const reversed: MovementRow[] = [
      { ...txn3[0], id: 'x1', role: 'reversal' },
      { ...txn3[1], id: 'x2', role: 'movement' },
    ];
    expect(laterRows(reversed).map((r) => r.id)).toEqual(['x1']);
  });
});

describe('sideLabel', () => {
  it('reads credit and debit as the direction they move an account', () => {
    expect(sideLabel('credit')).toBe('In');
    expect(sideLabel('debit')).toBe('Out');
  });

  it('passes an unexpected value through rather than inventing a direction', () => {
    expect(sideLabel('adjustment')).toBe('adjustment');
  });
});
