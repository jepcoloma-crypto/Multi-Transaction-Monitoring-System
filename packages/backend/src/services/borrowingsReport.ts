// Borrowings & repayments — the company's debt, lender by lender.
//
// The statement's `borrowingsOutstanding` is one number: the whole company's
// net, every lender mixed, from the start of the books to the end of the
// period. That figure answers "how much do we owe" and it must stay where it is
// — rebuilding it here would be a second opinion on the same debt. What it
// cannot answer is "to whom, and how are we repaying": there is no per-lender
// view anywhere in the system (D48 deferred one as pointless while there was
// exactly one lender; the pair has been written since, and a debt is only
// auditable once each lender's received and repaid sit on their own line).
//
// So this report is about flows, not balances: for each lender named in the
// period, how much was received and how much repaid, each netting to what that
// lender's debt moved by. The outstanding figure is still on the sheet — read
// from the same start-of-books-to-period-end ledger sum the statement uses, so
// the two can never disagree — but as a headline beside the flows, not inside
// them.
//
// Read from `transactions` rather than ledger rows for the same reason as the
// adjustments register: a borrowing recorded by a manager or operator sits
// pending until a second signature, and a pending transaction has no ledger
// rows. The flows here are a register of what was agreed; each row's status
// says whether the money has actually moved. The outstanding headline is the
// ledger's answer (it only ever counts posted rows), which is exactly the
// difference worth keeping visible.
//
// Pure: the route reads the rows and the outstanding figure, this decides what
// they mean.

import { manilaDateKey } from './manilaTime';

const cents = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

const money = (value: number): number => value / 100;

export const BORROWING_CODES: readonly ['loan_received', 'loan_repayment'] = ['loan_received', 'loan_repayment'];

const IS_RECEIVED = new Set<string>(['loan_received']);

// A borrowing entered without naming its lender is still money the company
// took on, and dropping it would make the rows fail to add back to the totals
// the lender lines are supposed to explain. Named rather than blank for the
// same reason the outgoings report names its uncategorised half.
const UNNAMED_LENDER = 'Unnamed lender';

export interface BorrowingSourceRow {
  id?: string | number;
  branch_id: string;
  branch_name?: string | null;
  account_name?: string | null;
  txn_code?: string | null;
  amount: string | number;
  payment_method?: string | null;
  transaction_number?: string | number | null;
  reference_number?: string | null;
  payee?: string | null;
  description?: string | null;
  status?: string | null;
  recorded_by_username?: string | null;
  transaction_date?: string | Date | null;
}

export interface BorrowingRow {
  id: string;
  code: 'loan_received' | 'loan_repayment';
  label: string;
  /** Manila day the borrowing is dated to, `YYYY-MM-DD`, or null. */
  day: string | null;
  amount: number;
  branchId: string;
  branchName: string | null;
  accountName: string | null;
  lender: string | null;
  route: string | null;
  status: string | null;
  transactionNumber: string | null;
  referenceNumber: string | null;
  description: string | null;
  recordedBy: string | null;
}

export interface LenderLine {
  /** The lender as named on the rows, trimmed; blank rows share `Unnamed lender`. */
  lender: string;
  received: number;
  repaid: number;
  /** received − repaid, so a positive number is still owed. */
  net: number;
  count: number;
}

export interface BorrowingBranchLine {
  branchId: string;
  name: string | null;
  received: number;
  repaid: number;
  net: number;
  count: number;
}

export interface BorrowingsReport {
  rows: BorrowingRow[];
  lenders: LenderLine[];
  branches: BorrowingBranchLine[];
  summary: {
    received: number;
    repaid: number;
    net: number;
    count: number;
    /** Rows still awaiting a second signature — the money has not moved yet. */
    pendingCount: number;
    /** Company-wide debt as of the period end, read from the ledger — the
     *  same figure the statement's `borrowingsOutstanding` carries. */
    outstandingToDate: number;
  };
}

const byNewest = (a: BorrowingRow, b: BorrowingRow): number =>
  (b.day ?? '').localeCompare(a.day ?? '') || Math.abs(b.amount) - Math.abs(a.amount) || a.label.localeCompare(b.label);

export function buildBorrowingsReport(rows: BorrowingSourceRow[], outstandingToDate = 0): BorrowingsReport {
  const listed: BorrowingRow[] = [];
  const byLender = new Map<string, { receivedCents: number; repaidCents: number; count: number }>();
  const byBranch = new Map<string, { name: string | null; receivedCents: number; repaidCents: number; count: number }>();

  let received = 0;
  let repaid = 0;
  let pendingCount = 0;

  for (const row of rows) {
    const code = BORROWING_CODES.find((c) => c === String(row.txn_code ?? ''));
    if (!code) continue;

    const isReceived = IS_RECEIVED.has(code);
    const amount = cents(row.amount);
    if (isReceived) received += amount;
    else repaid += amount;
    if (row.status === 'pending') pendingCount += 1;

    // Two lenders named differently on different rows are two lenders; the
    // ledger keeps the company-wide debt and cannot tell them apart, which is
    // precisely why this report names each row's payee. Trimmed, and blank
    // collapses to the named bucket rather than vanishing.
    const lender = String(row.payee ?? '').trim() || UNNAMED_LENDER;
    const lenderLine = byLender.get(lender) || { receivedCents: 0, repaidCents: 0, count: 0 };
    if (isReceived) lenderLine.receivedCents += amount;
    else lenderLine.repaidCents += amount;
    lenderLine.count += 1;
    byLender.set(lender, lenderLine);

    const branch = byBranch.get(row.branch_id)
      || { name: row.branch_name ?? null, receivedCents: 0, repaidCents: 0, count: 0 };
    if (isReceived) branch.receivedCents += amount;
    else branch.repaidCents += amount;
    branch.count += 1;
    byBranch.set(row.branch_id, branch);

    listed.push({
      id: String(row.id ?? `${row.transaction_number ?? ''}:${row.transaction_date ?? ''}:${amount}`),
      code,
      label: isReceived ? 'Borrowed funds received' : 'Loan repaid',
      day: dayKey(row.transaction_date),
      amount: isReceived ? money(amount) : -money(amount),
      branchId: row.branch_id,
      branchName: row.branch_name ?? null,
      accountName: row.account_name ?? null,
      lender,
      route: row.payment_method ?? null,
      status: row.status ?? null,
      transactionNumber: row.transaction_number === null || row.transaction_number === undefined
        ? null
        : String(row.transaction_number),
      referenceNumber: row.reference_number ?? null,
      description: row.description ?? null,
      recordedBy: row.recorded_by_username ?? null,
    });
  }

  listed.sort(byNewest);

  // Largest debt first: what the company owes most of is what it should be
  // looking at first. Ties break alphabetically so two runs print the same.
  const lenders: LenderLine[] = [...byLender.entries()]
    .map(([lender, l]) => ({
      lender,
      received: money(l.receivedCents),
      repaid: money(l.repaidCents),
      net: money(l.receivedCents - l.repaidCents),
      count: l.count,
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.lender.localeCompare(b.lender));

  const branches: BorrowingBranchLine[] = [...byBranch.entries()]
    .map(([branchId, b]) => ({
      branchId,
      name: b.name,
      received: money(b.receivedCents),
      repaid: money(b.repaidCents),
      net: money(b.receivedCents - b.repaidCents),
      count: b.count,
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || (a.name ?? '').localeCompare(b.name ?? ''));

  return {
    rows: listed,
    lenders,
    branches,
    summary: {
      received: money(received),
      repaid: money(repaid),
      net: money(received - repaid),
      count: listed.length,
      pendingCount,
      outstandingToDate,
    },
  };
}

const dayKey = (value: string | Date | null | undefined): string | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : manilaDateKey(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : manilaDateKey(parsed);
  }
  return null;
};
