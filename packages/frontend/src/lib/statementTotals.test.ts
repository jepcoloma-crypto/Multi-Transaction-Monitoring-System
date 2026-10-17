import { describe, it, expect } from 'vitest';
import { statementTotals } from './statementTotals';
import type { StatementTotalsEntry } from './statementTotals';

// Paula Bayubay's statement around TX #41: a ₱4,116 bill payment carrying a
// ₱15 Home Credit charge and a ₱50 fee, undone and re-entered the same day
// as TX #131 — the row set that showed ₱30 under Total Charges instead of
// the ₱15 that stands.
const REVERSAL_PAIR: StatementTotalsEntry[] = [
  { entry_type: 'credit', amount: '4131.00', fee: '0.00', charges_total: 0, statement_status: 'reversal' },
  { entry_type: 'debit', amount: '4131.00', fee: '50.00', charges_total: 15, statement_status: 'reversed' },
  { entry_type: 'debit', amount: '4131.00', fee: '50.00', charges_total: 15, statement_status: 'completed' },
];

describe('statementTotals', () => {
  it('counts the charge of the movement that stands, not the one that was undone', () => {
    expect(statementTotals(REVERSAL_PAIR).charges).toBe(15);
  });

  it('leaves out the fee the reversal handed back', () => {
    expect(statementTotals(REVERSAL_PAIR).fees).toBe(50);
  });

  it('keeps money in and money out gross so the footer still ties to the balance column', () => {
    const totals = statementTotals(REVERSAL_PAIR);
    expect(totals.moneyIn).toBe(4131);
    expect(totals.moneyOut).toBe(8262);
  });

  it('never counts the row that undid a movement, whatever columns ride on it', () => {
    const totals = statementTotals([
      { entry_type: 'credit', amount: '50.00', fee: '50.00', charges_total: 15, statement_status: 'reversal' },
    ]);
    expect(totals.fees).toBe(0);
    expect(totals.charges).toBe(0);
    expect(totals.moneyIn).toBe(50);
  });

  it('reads a fee row as the amount that moved, not as another fee', () => {
    // D37: the row that is the fee carries fee null and charges 0 — its own
    // amount is the fee money itself.
    const totals = statementTotals([
      { entry_type: 'credit', amount: '50.00', fee: null, charges_total: 0, statement_status: 'completed' },
    ]);
    expect(totals.fees).toBe(0);
    expect(totals.moneyIn).toBe(50);
  });

  it('treats a blank column as no money rather than a broken row', () => {
    const totals = statementTotals([{ entry_type: 'debit', amount: '100.00', statement_status: null }]);
    expect(totals.fees).toBe(0);
    expect(totals.charges).toBe(0);
    expect(totals.moneyOut).toBe(100);
  });
});
