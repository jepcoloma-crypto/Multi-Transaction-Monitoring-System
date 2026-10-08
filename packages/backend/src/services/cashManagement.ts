// Shapes ledger rows into a Sources and Uses statement with a tie-out against
// account balances. Pure — no network, no database — so every bucket and
// subtotal is testable without one.
//
// The statement is built from ledger_entries rather than from the income
// report's figures on purpose. Fee income is not a separate credit anywhere in
// the ledger: a transfer posts one debit to the sender and one credit to the
// receiver, and the fee rides inside them. A statement that tried to reproduce
// totalIncome would therefore stop adding up to the balance it exists to
// explain.
//
// So the two answer different questions and are not expected to agree:
//   this one   — where did the cash physically move
//   income     — what did the company earn
//
// Because every ledger row lands in exactly one bucket, the tie-out holds by
// construction: opening + Σsources − Σuses = closing. If it ever does not,
// rows have been dropped or double-counted, which is what the check exposes.

import { manilaDateTimeKey } from './manilaTime';

export type CashBucket =
  | 'owner_capital'
  | 'transfers'
  | 'customer_cash'
  | 'load'
  | 'operating_expenses'
  | 'provider_charges'
  | 'payments'
  | 'other_income'
  | 'adjustments'
  | 'corrections'
  | 'opening_float'
  | 'other';

export const BUCKET_LABELS: Record<CashBucket, string> = {
  owner_capital: 'Owner Capital',
  transfers: 'Branch Transfers',
  customer_cash: 'Customer Cash',
  load: 'Load',
  operating_expenses: 'Operating Expenses',
  provider_charges: 'Provider Charges',
  payments: 'Payments & Bills',
  other_income: 'Other Income',
  adjustments: 'Adjustments',
  corrections: 'Corrections',
  opening_float: 'Opening Float',
  other: 'Other',
};

// The buckets where the drawer paid out the company's own money, and the only
// rows that make up a cash expense.
//
// Direction alone cannot answer this. `owner_return` and `cash_out` both leave
// the drawer, but an owner drawing capital back out and a customer being handed
// their money are settlements, not spending — totalling every debit would have
// booked a 200,000 owner return as an expense. These three are the rows where
// the company was the party that paid.
export const EXPENSE_BUCKETS: readonly CashBucket[] = [
  'operating_expenses',
  'provider_charges',
  'payments',
];

const toCents = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

// The movement codes where money can physically change hands, and so the only
// ones asked for a payment method. These are the codes the drawer gate keys on;
// every other type is money moving between accounts rather than through them.
export const CASH_MOVEMENT_CODES = [
  'cash_in',
  'cash_out',
  'customer_payment',
  'customer_withdrawal',
] as const;

// Everything the column may store, matching paymentMethodOptions on the client.
export const PAYMENT_METHODS = ['cash', 'gcash', 'bank', 'maya', 'provider_interest'] as const;

// provider_interest is excluded from what a cash movement may carry: it
// describes where an interest credit came from, not how cash was handed over,
// and accepting it on a cash movement would record a method the operator could
// not have used.
export const MOVEMENT_PAYMENT_METHODS = ['cash', 'gcash', 'bank', 'maya'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type MovementPaymentMethod = (typeof MOVEMENT_PAYMENT_METHODS)[number];

export function isCashMovement(code: string | null | undefined): boolean {
  return (CASH_MOVEMENT_CODES as readonly string[]).includes(String(code));
}

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value);
}

export function isMovementPaymentMethod(value: unknown): value is MovementPaymentMethod {
  return typeof value === 'string' && (MOVEMENT_PAYMENT_METHODS as readonly string[]).includes(value);
}

export interface DrawerLeg {
  amount: number;
  entryType: 'debit' | 'credit';
}

// What the drawer does when a movement is settled in physical cash.
//
// The drawer and the account are two pools of the same money, so a cash
// movement transfers between them: the drawer moves opposite to the account
// leg, and the fee is credited back to the drawer as income.
//
//   cash-in,  separate   account +500   drawer -490
//   cash-in,  deducted   account +490   drawer -480
//   cash-out, separate   account -500   drawer +510
//   cash-out, deducted   account -500   drawer +510
//
// The sign is what makes the two legs sum to the fee in every row:
//
//     signedAmount + (fee - signedAmount) = fee
//
// so the books grow by exactly what the income report books. Adding them in
// the same direction instead grew the total by the whole movement again — a
// ₱500 cash-in would have added ₱990 to the total while income reported ₱10.
// The two cash-out rows coincide because a debit is never shrunk by a deducted
// fee (D13): the account loses the whole 500 and the drawer keeps the 10.
//
// `signedAmount` is the signed account leg; `fee` is always positive. Null means
// nothing physically changed hands and no ledger row should be written.
export function drawerLeg(signedAmount: number, fee: number): DrawerLeg | null {
  const delta = Math.round((fee - signedAmount) * 100) / 100;
  if (delta === 0) return null;
  return delta > 0
    ? { amount: delta, entryType: 'credit' }
    : { amount: -delta, entryType: 'debit' };
}

// The drawer participates only when the money is physically handed over. A
// GCash or bank movement lands in the wallet without passing through it, and
// giving those a drawer leg would double-count the same peso.
export function touchesDrawer(paymentMethod: string | null | undefined): boolean {
  return paymentMethod === 'cash';
}

const money = (cents: number): number => cents / 100;

// A ledger row carries either a transaction (source_type 'transaction', with
// the type code reachable through it) or a non-transaction source such as a
// transfer, a loading operation, an admin balance edit or a gap fix. The
// transaction's type code is the more specific signal, so it wins whenever it
// is present — including for adjustment rows, which post through the same path
// as any other transaction even though their name suggests otherwise.
export function bucketFor(sourceType: string | null | undefined, txnCode: string | null | undefined): CashBucket {
  if (txnCode) {
    switch (txnCode) {
      case 'owner_funding':
      case 'owner_return':
        return 'owner_capital';
      case 'transfer_in':
      case 'transfer_out':
        return 'transfers';
      case 'cash_in':
      case 'cash_out':
      case 'customer_payment':
      case 'customer_withdrawal':
        return 'customer_cash';
      case 'load_purchase':
        return 'load';
      case 'operating_expense':
        return 'operating_expenses';
      case 'expense':
        return 'provider_charges';
      case 'service_fee':
      case 'bill_payment':
      case 'refund':
        return 'payments';
      case 'other_income':
      case 'refund_received':
        return 'other_income';
      case 'adjustment_in':
      case 'adjustment_out':
        return 'adjustments';
      default:
        return 'other';
    }
  }

  switch (sourceType) {
    case 'transfer':
      return 'transfers';
    case 'loading':
      return 'load';
    case 'adjustment':
      return 'adjustments';
    case 'gap_fix':
      return 'corrections';
    // A shift's float. A shift writes no ledger row, so no row of this kind is
    // written today; a row that names this source is still classified by it
    // rather than falling through to Other, so the register reads a float as a
    // float the moment one is ever posted.
    case 'opening_float':
    case 'shift':
      return 'opening_float';
    default:
      return 'other';
  }
}

export interface LedgerFlowRow {
  branch_id: string;
  entry_type: 'credit' | 'debit';
  amount: string | number;
  source_type: string | null;
  txn_code: string | null;
}

export interface BranchBalance {
  id: string;
  code: string;
  name: string;
  opening: string | number;
  current: string | number;
}

export interface BucketLine {
  bucket: CashBucket;
  label: string;
  amount: number;
  count: number;
}

export interface BranchStatement {
  branchId: string;
  code: string;
  name: string;
  opening: number;
  sources: number;
  uses: number;
  closing: number;
  current: number;
}

export interface CashStatement {
  sources: BucketLine[];
  uses: BucketLine[];
  branches: BranchStatement[];
  totals: {
    opening: number;
    sources: number;
    uses: number;
    closing: number;
    current: number;
    difference: number;
    balanced: boolean;
  };
}

const sortByAmount = (a: BucketLine, b: BucketLine): number =>
  b.amount - a.amount || a.label.localeCompare(b.label);

export function buildCashStatement(rows: LedgerFlowRow[], branches: BranchBalance[]): CashStatement {
  const sourceCents = new Map<CashBucket, number>();
  const sourceCounts = new Map<CashBucket, number>();
  const useCents = new Map<CashBucket, number>();
  const useCounts = new Map<CashBucket, number>();

  const branchSources = new Map<string, number>();
  const branchUses = new Map<string, number>();

  for (const row of rows) {
    const bucket = bucketFor(row.source_type, row.txn_code);
    const cents = toCents(row.amount);
    const isCredit = row.entry_type === 'credit';

    const totals = isCredit ? sourceCents : useCents;
    const counts = isCredit ? sourceCounts : useCounts;
    totals.set(bucket, (totals.get(bucket) || 0) + cents);
    counts.set(bucket, (counts.get(bucket) || 0) + 1);

    const perBranch = isCredit ? branchSources : branchUses;
    perBranch.set(row.branch_id, (perBranch.get(row.branch_id) || 0) + cents);
  }

  const sources: BucketLine[] = [...sourceCents.entries()].map(([bucket, amount]) => ({
    bucket,
    label: BUCKET_LABELS[bucket],
    amount: money(amount),
    count: sourceCounts.get(bucket) || 0,
  })).sort(sortByAmount);

  const uses: BucketLine[] = [...useCents.entries()].map(([bucket, amount]) => ({
    bucket,
    label: BUCKET_LABELS[bucket],
    amount: money(amount),
    count: useCounts.get(bucket) || 0,
  })).sort(sortByAmount);

  const branchStatements: BranchStatement[] = branches.map((branch) => {
    const opening = toCents(branch.opening);
    const branchSource = branchSources.get(branch.id) || 0;
    const branchUse = branchUses.get(branch.id) || 0;
    return {
      branchId: branch.id,
      code: branch.code,
      name: branch.name,
      opening: money(opening),
      sources: money(branchSource),
      uses: money(branchUse),
      closing: money(opening + branchSource - branchUse),
      current: toCents(branch.current) / 100,
    };
  });

  const sum = (pick: (b: BranchStatement) => number): number =>
    branchStatements.reduce((total, b) => total + toCents(pick(b)), 0);

  const opening = sum((b) => b.opening);
  const branchSourceTotal = sum((b) => b.sources);
  const branchUseTotal = sum((b) => b.uses);
  const closing = sum((b) => b.closing);
  const current = sum((b) => b.current);
  const difference = closing - current;

  return {
    sources,
    uses,
    branches: branchStatements,
    totals: {
      opening: money(opening),
      sources: money(branchSourceTotal),
      uses: money(branchUseTotal),
      closing: money(closing),
      current: money(current),
      difference: money(difference),
      // Only expected to be zero when the period reaches the present. A
      // statement covering a past window closes at its own end date and will
      // legitimately differ from today's balance.
      balanced: difference === 0,
    },
  };
}

// The cash register — every ledger row that touched a branch's cash accounts,
// newest first. This is the drawer's full history: what "Total on the books"
// and "Cash on hand" are built from, in the order the balance moved. It answers
// "what has been recorded against cash" without a period filter, because a list
// of what exists is a point-in-time question, not the period question D18 keeps
// off this screen.
//
// Classified with `bucketFor`, the same function the position statement uses,
// so a row reads the same in the list as it reads in the totals it belongs to.
export interface CashRecordRaw {
  id: string;
  entry_date: string | Date;
  entry_type: string;
  amount: string | number;
  balance_after: string | number;
  source_type: string | null;
  reference_number: string | null;
  description: string | null;
  account_name: string;
  branch_code: string | null;
  branch_name: string | null;
  transaction_number: number | string | null;
  transaction_date: string | Date | null;
  payee: string | null;
  txn_code: string | null;
  payment_method: string | null;
  created_by_username: string | null;
}

export interface CashRecordRow {
  id: string;
  // The day the row is filed under — the transaction's business date where one
  // exists, the posting instant otherwise. The register reads this, not
  // `entryDate`: an expense entered for Sep 25 files under Sep 25 even when it
  // was posted into the drawer on Oct 7.
  businessDate: string;
  // The instant the row actually hit the drawer. Kept beside the business date
  // so the two can be told apart when they differ.
  entryDate: string;
  direction: 'in' | 'out';
  bucket: CashBucket;
  category: string;
  amount: string;
  balanceAfter: string;
  accountName: string;
  branchCode: string | null;
  branchName: string | null;
  transactionNumber: number | null;
  paymentMethod: string | null;
  payee: string | null;
  referenceNumber: string | null;
  description: string | null;
  recordedBy: string | null;
}

const moneyString = (value: unknown): string => (toCents(value) / 100).toFixed(2);

export function toCashRecordRow(raw: CashRecordRaw): CashRecordRow {
  const bucket = bucketFor(raw.source_type, raw.txn_code);
  const number = raw.transaction_number === null || raw.transaction_number === undefined || raw.transaction_number === ''
    ? null
    : Number(raw.transaction_number);
  // The business date the operator named, falling back to the posting instant
  // for a row with no transaction (a transfer, adjustment or gap fix). Parse
  // rather than concatenate, so an invalid value falls back too instead of
  // reaching the formatter as garbage.
  const entryDate = new Date(raw.entry_date).toISOString();
  const business = raw.transaction_date ? new Date(raw.transaction_date) : null;
  return {
    id: raw.id,
    businessDate: business && !Number.isNaN(business.getTime()) ? business.toISOString() : entryDate,
    entryDate,
    direction: raw.entry_type === 'credit' ? 'in' : 'out',
    bucket,
    category: BUCKET_LABELS[bucket],
    amount: moneyString(raw.amount),
    balanceAfter: moneyString(raw.balance_after),
    accountName: raw.account_name,
    branchCode: raw.branch_code,
    branchName: raw.branch_name,
    transactionNumber: Number.isFinite(number as number) ? number : null,
    paymentMethod: raw.payment_method,
    payee: raw.payee,
    referenceNumber: raw.reference_number,
    description: raw.description,
    recordedBy: raw.created_by_username,
  };
}

export function isExpenseBucket(bucket: CashBucket): boolean {
  return EXPENSE_BUCKETS.includes(bucket);
}

// The expense total for exactly the rows the register is showing.
//
// Sums money out only: an expense-bucket row facing the other way is a refund
// coming back, not spending, and reversals post to `adjustments` rather than
// into the bucket they reverse. Computed over the filtered population rather
// than the current page, so the figure describes every row the record count
// names instead of one screen of them.
//
// Pure — no network, no database — so the endpoint and its test run the same
// function (AGENTS.md architecture rule 1).
export function cashExpenseTotal(rows: CashRecordRow[]): string {
  let cents = 0;
  for (const row of rows) {
    if (row.direction === 'out' && isExpenseBucket(row.bucket)) cents += toCents(row.amount);
  }
  return (cents / 100).toFixed(2);
}

const csvCell = (value: unknown): string => {
  const normalized = value === null || value === undefined ? '' : String(value);
  return `"${normalized.replace(/"/g, '""')}"`;
};

const CASH_RECORD_COLUMNS: { header: string; key: keyof CashRecordRow }[] = [
  { header: 'Business Day', key: 'businessDate' },
  { header: 'Posted At', key: 'entryDate' },
  { header: 'Branch', key: 'branchCode' },
  { header: 'Account', key: 'accountName' },
  { header: 'Txn #', key: 'transactionNumber' },
  { header: 'Type', key: 'category' },
  { header: 'Direction', key: 'direction' },
  { header: 'Amount', key: 'amount' },
  { header: 'Balance After', key: 'balanceAfter' },
  { header: 'Payment Method', key: 'paymentMethod' },
  { header: 'Payee', key: 'payee' },
  { header: 'Reference', key: 'referenceNumber' },
  { header: 'Description', key: 'description' },
  { header: 'Recorded By', key: 'recordedBy' },
];

/**
 * The register as CSV. Both dates are read by `manilaDateTimeKey` rather than
 * the instant's UTC text, so a row filed under Sep 25 in Manila is not exported
 * as Sep 24, and one posted Oct 7 is not exported as Oct 6 — the same
 * off-by-a-day a report's last day used to lose. The BOM lets Excel read the
 * peso signs and dashes the description column may carry.
 */
export function cashRecordsCsv(rows: CashRecordRow[]): string {
  const lines = [CASH_RECORD_COLUMNS.map(c => csvCell(c.header)).join(',')];
  for (const row of rows) {
    const cells = CASH_RECORD_COLUMNS.map(c => {
      const value = c.key === 'businessDate' || c.key === 'entryDate'
        ? manilaDateTimeKey(new Date(row[c.key])).replace('T', ' ')
        : row[c.key];
      return csvCell(value);
    });
    lines.push(cells.join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}
