import { formatCurrency, manilaDateTimeLabel, paymentMethodCell, transactionTypeLabel } from '../lib/format';

// The fields a receipt reads, deliberately narrower than the detail's
// Transaction. Two shapes hand it a row: `GET /transactions/:id` (the joined
// view — account, type and cashier names) after a save, and the detail
// modal's list row for a reprint. The raw create response lacks the joins, so
// everything the joins provide is optional here: a refetch that fails still
// puts the number, amount, status and time on paper rather than nothing.
export interface ReceiptTx {
  id: string;
  transaction_number: number;
  transaction_date: string;
  status: string;
  amount: number;
  fee: number;
  fee_added_to_balance?: boolean | null;
  additional_charges?: { description: string; amount: number }[] | null;
  reference_number?: string | null;
  customer_name?: string | null;
  customer_contact?: string | null;
  payment_method?: string | null;
  description?: string | null;
  account_name?: string | null;
  type_name?: string | null;
  type_code?: string | null;
  category_name?: string | null;
  created_by_username?: string | null;
  rejection_reason?: string | null;
}

/**
 * The 80mm thermal receipt for one transaction.
 *
 * It is never a screen view: the sheet is `hidden` until print media, and the
 * page it belongs to renders it outside its root for exactly the frame
 * `window.print()` runs — window.print() takes the document as a whole, so
 * everything else carries `print:hidden` while this is mounted (the same
 * arrangement as the shift sheets in CashManagement). `index.css` carries the
 * matching `@page receipt` that sizes the paper to the roll.
 *
 * Every figure here is read straight off the row. The bottom line is the
 * total the customer hands over — the price, not a claim about the balance —
 * so it must agree with the create form's "Customer pays" and the cash
 * figure the detail drawer prints for this movement.
 */
export default function CashReceipt(props: {
  tx: ReceiptTx;
  /** The operator's branch, shown only when their access names exactly one. */
  branchName?: string | null;
  /** Who hit print, for the footer; a joined row names the creator itself. */
  printedBy?: string | null;
  /** When *this* sheet printed — for a reprint, not the transaction's time. */
  printedAt: string | Date;
}) {
  const { tx, branchName, printedBy, printedAt } = props;

  const row = (label: string, value: string, emphasis = false) => (
    <div className={`flex justify-between gap-3 ${emphasis ? 'font-bold' : ''}`}>
      <span>{label}</span>
      {/* min-w-0 so a long reference or description wraps inside the column
          instead of pushing the receipt wider than the roll. */}
      <span className="min-w-0 text-right font-mono break-words">{value}</span>
    </div>
  );

  const charges = tx.additional_charges || [];
  const chargesTotal = charges.reduce((sum, c) => sum + Number(c.amount || 0), 0);

  // What the customer pays: the amount plus the additional charges printed
  // above, plus the fee only when it was charged on top
  // (fee_added_to_balance). A fee carved out of the amount is already inside
  // `amount`, so adding it there would double-count. Shown for every status —
  // this is the price of the transaction, not a movement claim; the status
  // note below is what tells the customer whether the money has moved yet.
  const total =
    tx.amount + chargesTotal + (tx.fee_added_to_balance ? tx.fee : 0);

  // Same sentences the detail banners read, because a receipt handed across a
  // counter is exactly where "pending" must not look like "done".
  const statusNote =
    tx.status === 'pending'
      ? 'Awaiting admin approval \u2014 the account balance has not changed yet.'
      : tx.status === 'rejected'
        ? `Rejected${tx.rejection_reason ? `: ${tx.rejection_reason}` : ' \u2014 no money moved.'}`
        : null;

  const typeText =
    [transactionTypeLabel(tx.type_code, tx.type_name), tx.category_name].filter(Boolean).join(' / ') || '\u2014';

  return (
    <div className="receipt-sheet hidden print:block box-border w-full bg-white p-3 text-[11px] leading-snug text-black">
      <div className="text-center">
        <p className="text-[13px] font-bold uppercase tracking-wide">Transaction Receipt</p>
        <p className="text-[10px]">Multi-Account Financial &amp; Loading Monitor</p>
        {branchName && <p className="text-[10px] font-semibold">{branchName}</p>}
      </div>

      <div className="mt-2 space-y-0.5 border-t border-black pt-1.5">
        {row('Date', manilaDateTimeLabel(tx.transaction_date))}
        {row('Receipt #', `#${tx.transaction_number}`)}
        {row('Status', tx.status.toUpperCase())}
        {row('Method', paymentMethodCell(tx.payment_method))}
      </div>

      <div className="mt-2 space-y-0.5 border-t border-black pt-1.5">
        {row('Account', tx.account_name || '\u2014')}
        {row('Type', typeText)}
        {tx.customer_name && row('Customer', tx.customer_name)}
        {tx.customer_contact && row('Contact', tx.customer_contact)}
        {tx.reference_number && row('Reference', tx.reference_number)}
        {tx.description && row('Description', tx.description)}
      </div>

      <div className="mt-2 space-y-0.5 border-t border-black pt-1.5">
        {row('Amount', formatCurrency(tx.amount))}
        {row('Fee', formatCurrency(tx.fee))}
        {charges.map((c, i) => row(c.description || `Charge ${i + 1}`, formatCurrency(Number(c.amount))))}
        {charges.length > 0 && row('Total additional charges', formatCurrency(chargesTotal), true)}
        {row('Total', formatCurrency(total), true)}
      </div>

      {statusNote && (
        <p className="mt-2 border-t border-black pt-1.5 text-center font-semibold">{statusNote}</p>
      )}

      <div className="mt-3 border-t border-black pt-1.5 text-center text-[10px]">
        <p>Cashier: {tx.created_by_username || printedBy || '\u2014'}</p>
        <p>Printed {manilaDateTimeLabel(printedAt)}</p>
        <p className="mt-1">System-generated receipt</p>
      </div>
    </div>
  );
}
