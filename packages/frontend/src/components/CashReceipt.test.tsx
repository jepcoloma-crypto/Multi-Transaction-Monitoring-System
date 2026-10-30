import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import CashReceipt from './CashReceipt';
import type { ReceiptTx } from './CashReceipt';
import { manilaDateTimeLabel } from '../lib/format';

// What a completed cash sale hands across the counter: fee inside the amount,
// one additional charge, every name joined from the server's view.
const sold: ReceiptTx = {
  id: 't1',
  transaction_number: 1234,
  transaction_date: '2026-10-29T06:05:00.000Z',
  status: 'completed',
  amount: 500,
  fee: 10,
  fee_added_to_balance: false,
  additional_charges: [{ description: 'Packing fee', amount: 5 }],
  reference_number: 'REF-7788',
  customer_name: 'Juan Dela Cruz',
  customer_contact: '09171234567',
  payment_method: 'cash',
  account_name: 'Revolving Fund',
  type_name: 'Cash Out',
  type_code: 'cash_out',
  created_by_username: 'maria',
};

const renderReceipt = (tx: ReceiptTx, props: { branchName?: string | null; printedBy?: string | null } = {}) =>
  render(
    <CashReceipt
      tx={tx}
      branchName={props.branchName === undefined ? 'Main Branch' : props.branchName}
      printedBy={props.printedBy === undefined ? 'admin' : props.printedBy}
      printedAt="2026-10-29T06:05:10.000Z"
    />
  );

describe('CashReceipt', () => {
  it('prints the identity of the transaction, the branch and the cashier', () => {
    renderReceipt(sold);
    expect(screen.getByText('Transaction Receipt')).toBeTruthy();
    expect(screen.getByText('Main Branch')).toBeTruthy();
    expect(screen.getByText('#1234')).toBeTruthy();
    expect(screen.getByText('COMPLETED')).toBeTruthy();
    expect(screen.getByText('Cash')).toBeTruthy();
    expect(screen.getByText('Revolving Fund')).toBeTruthy();
    expect(screen.getByText(/Cash received/)).toBeTruthy();
    expect(screen.getByText('Juan Dela Cruz')).toBeTruthy();
    expect(screen.getByText('REF-7788')).toBeTruthy();
    expect(screen.getByText('Cashier: maria')).toBeTruthy();
  });

  it('reads the transaction time on the Manila clock, not the browser’s', () => {
    renderReceipt(sold);
    expect(screen.getByText(manilaDateTimeLabel('2026-10-29T06:05:00.000Z'))).toBeTruthy();
    expect(screen.getByText(`Printed ${manilaDateTimeLabel('2026-10-29T06:05:10.000Z')}`)).toBeTruthy();
  });

  it('totals what the customer pays — amount plus charges, fee already inside', () => {
    renderReceipt(sold);
    expect(screen.getByText('₱500.00')).toBeTruthy();
    expect(screen.getByText('₱10.00')).toBeTruthy();
    // The charge appears as its own line and again as the section total.
    expect(screen.getAllByText('₱5.00')).toHaveLength(2);
    expect(screen.getByText('Total additional charges')).toBeTruthy();
    // 500 + 5 — the fee was carved from the amount, so it is not added again.
    expect(screen.getByText('Total')).toBeTruthy();
    expect(screen.getByText('₱505.00')).toBeTruthy();
  });

  it('adds the fee on top of the amount when the customer paid it separately', () => {
    renderReceipt({ ...sold, fee_added_to_balance: true });
    // 500 + 10 + 5 — amount, the on-top fee, and the charge.
    expect(screen.getByText('₱515.00')).toBeTruthy();
  });

  it('still totals the price on a pending receipt while saying no money moved', () => {
    renderReceipt({ ...sold, status: 'pending' });
    // The total is what the customer owes, pending or not — it is not a
    // claim that the balance changed, which is the note's job.
    expect(screen.queryByText(/Account movement/)).toBeNull();
    expect(screen.getByText('Total')).toBeTruthy();
    expect(screen.getByText('₱505.00')).toBeTruthy();
    expect(screen.getByText(/account balance has not changed/)).toBeTruthy();
  });

  it('explains a rejection, carrying the reason when the row has one', () => {
    renderReceipt({ ...sold, status: 'rejected', rejection_reason: 'duplicate entry' });
    expect(screen.getByText(/Rejected: duplicate entry/)).toBeTruthy();
    renderReceipt({ ...sold, status: 'rejected' });
    expect(screen.getByText(/Rejected . no money moved/)).toBeTruthy();
  });

  it('still puts the money on paper when the joined view was unavailable', () => {
    // The raw create response: the raw table row — no account, type or
    // cashier joins — which is what prints if the read-back fails after a save.
    const rawRow: ReceiptTx = {
      id: 't2',
      transaction_number: 44,
      transaction_date: '2026-10-29T06:05:00.000Z',
      status: 'completed',
      amount: 500,
      fee: 10,
      fee_added_to_balance: false,
      additional_charges: [],
      payment_method: 'cash',
    };
    renderReceipt(rawRow, { branchName: null, printedBy: 'admin' });
    expect(screen.getByText('#44')).toBeTruthy();
    // Amount and Total are both ₱500 here (no charges, fee inside the
    // amount), so the figure legitimately appears twice.
    expect(screen.getAllByText('₱500.00')).toHaveLength(2);
    expect(screen.getByText('Total')).toBeTruthy();
    // Account and type are the joins the raw row lacks: said, not invented.
    // The cashier of record isn't missing — it falls back to the session.
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.getByText('Cashier: admin')).toBeTruthy();
    expect(screen.queryByText('Main Branch')).toBeNull();
  });

  it('marks itself as the receipt page, hidden until the paper is in', () => {
    const { container } = renderReceipt(sold);
    const sheet = container.querySelector('.receipt-sheet');
    expect(sheet).toBeTruthy();
    expect(sheet!.classList.contains('hidden')).toBe(true);
    expect(sheet!.classList.contains('print:block')).toBe(true);
  });
});
