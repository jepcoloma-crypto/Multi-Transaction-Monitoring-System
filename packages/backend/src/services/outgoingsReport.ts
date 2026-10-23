// R1 — Outgoings by purpose: what the two "hand money out" forms recorded, read
// side by side.
//
// The module has two forms that pay money out of a branch and they offer the
// SAME categories — Rent, Salary, Utilities, Supplier Payment, Bank Fee… (the
// 29 categories behind `PAYMENT_PURPOSE_CODES` and the expense form's picker).
// They file under different transaction types, though, and only one of them
// counts as spending:
//
//   operating_expense   reaches the expense reports (reports.ts `opexConds`)
//   cash_payment        deliberately does not — migration 045 gave it its own
//                       bucket, outside EXPENSE_BUCKETS, because "cash that
//                       left and never was a cost of the business" (a supplier,
//                       a bill settled, cash handed to a collector) is not the
//                       cost of running the company
//
// So neither form can answer "what did this branch pay out in March" alone, and
// nothing else in the system reads both at once: the expense report sees only
// the first half, Sources and Uses totals them as two separate bucket lines
// with no category under either, and the register lists rows without a period
// (D18). This report keeps the halves apart — folding them would quietly turn
// a supplier payment into a business expense, which is the exact lie migration
// 045 exists to prevent — while putting the same purpose on one line so the
// figure is answerable at all.
//
// Built on ledger rows, not transactions, for the same reason Sources and Uses
// is: the statement has no status filter (a reversal stays in its bucket
// because the cash really did move), so a report that counted `transactions`
// would drop reversed originals while the bucket beside it kept them, and the
// two would disagree about the same peso. Both halves are summed in whole
// centavos — a printed total that disagrees with its own rows by a fraction is
// a total nobody trusts.
//
// Pure: the route reads the rows, this decides what they mean.

const cents = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

const money = (value: number): number => value / 100;

// The two halves, named for what they do rather than left and right: a column
// labelled "payment" beside one labelled "expense" invites the two to be summed,
// and this report exists precisely to keep them distinguishable.
export const OUTGOINGS_HALVES = {
  expense: {
    code: 'operating_expense',
    label: 'Counts in expense totals',
  },
  payment: {
    code: 'cash_payment',
    label: 'Outside expense totals',
  },
} as const;

export type OutgoingsHalf = keyof typeof OUTGOINGS_HALVES;

const HALF_BY_CODE: Record<string, OutgoingsHalf> = {
  operating_expense: 'expense',
  cash_payment: 'payment',
};

/** The transaction type codes this report reads, for the route's WHERE clause. */
export const OUTGOINGS_CODES: readonly string[] = Object.keys(HALF_BY_CODE);

// A category is the same one on both forms, so one line holds both halves. A row
// filed with no category is still money that left, and naming it rather than
// dropping it is what keeps the rows adding back to the total.
const UNCATEGORISED = 'Uncategorised';

export interface OutgoingsSourceRow {
  id?: string | number;
  branch_id: string;
  branch_name?: string | null;
  // The ledger's own truth. A debit left the drawer; a credit is money that
  // came back — the same reading `buildCashStatement` applies to a bucket.
  entry_type: 'credit' | 'debit';
  amount: string | number;
  source_type?: string | null;
  txn_code?: string | null;
  payment_method?: string | null;
  transaction_id?: string | null;
  transaction_number?: string | number | null;
  category_id?: string | null;
  category_name?: string | null;
  payee?: string | null;
  reference_number?: string | null;
  description?: string | null;
  entry_date?: string | Date | null;
}

export interface OutgoingsCategory {
  category: string;
  categoryId: string | null;
  /** The operating-expense half, in pesos. */
  expense: number;
  /** The cash-payment half, in pesos — never added to the expense figure. */
  payment: number;
  total: number;
  count: number;
  expenseCount: number;
  paymentCount: number;
}

export interface OutgoingsBranch {
  branchId: string;
  name: string | null;
  expense: number;
  payment: number;
  total: number;
  count: number;
}

export interface OutgoingsReport {
  rows: OutgoingsCategory[];
  branches: OutgoingsBranch[];
  summary: {
    totalOutgoings: number;
    expenseTotal: number;
    paymentTotal: number;
    count: number;
    expenseCount: number;
    paymentCount: number;
    branchCount: number;
  };
}

// Largest first: an outgoings sheet read top-down should show what actually
// left the drawer before what didn't. Ties break alphabetically so two runs over
// the same period print in the same order.
const byMagnitude = (a: OutgoingsCategory, b: OutgoingsCategory): number =>
  Math.abs(b.total) - Math.abs(a.total) || a.category.localeCompare(b.category);

export function buildOutgoingsReport(rows: OutgoingsSourceRow[]): OutgoingsReport {
  const byCategory = new Map<string, { cents: number; count: number; expenseCents: number; expenseCount: number; paymentCents: number; paymentCount: number; categoryId: string | null }>();
  const byBranch = new Map<string, { name: string | null; expenseCents: number; paymentCents: number; count: number }>();

  let expenseTotal = 0;
  let paymentTotal = 0;
  let expenseCount = 0;
  let paymentCount = 0;

  for (const row of rows) {
    // A row this report was not asked for is ignored rather than counted as an
    // outgoings of some third kind: the route selects on the two buckets, so
    // anything else here is a caller's mistake and must not reach a total.
    const half = HALF_BY_CODE[String(row.txn_code ?? '')];
    if (!half) continue;

    // Signed outwards: a debit is money that left, a credit reduces what was
    // paid out. Not the type's nominal direction — the ledger's entry type,
    // which is what the statement reads.
    const signed = row.entry_type === 'credit' ? -cents(row.amount) : cents(row.amount);

    const key = String(row.category_name ?? '').trim() || UNCATEGORISED;
    const category = byCategory.get(key)
      || { cents: 0, count: 0, expenseCents: 0, expenseCount: 0, paymentCents: 0, paymentCount: 0, categoryId: null };
    category.cents += signed;
    category.count += 1;
    if (row.category_id && !category.categoryId) category.categoryId = String(row.category_id);
    if (half === 'expense') {
      category.expenseCents += signed;
      category.expenseCount += 1;
      expenseTotal += signed;
      expenseCount += 1;
    } else {
      category.paymentCents += signed;
      category.paymentCount += 1;
      paymentTotal += signed;
      paymentCount += 1;
    }
    byCategory.set(key, category);

    const branch = byBranch.get(row.branch_id)
      || { name: row.branch_name ?? null, expenseCents: 0, paymentCents: 0, count: 0 };
    if (half === 'expense') branch.expenseCents += signed;
    else branch.paymentCents += signed;
    branch.count += 1;
    byBranch.set(row.branch_id, branch);
  }

  const rowsOut: OutgoingsCategory[] = [...byCategory.entries()]
    .map(([category, c]) => ({
      category,
      categoryId: c.categoryId,
      expense: money(c.expenseCents),
      payment: money(c.paymentCents),
      total: money(c.cents),
      count: c.count,
      expenseCount: c.expenseCount,
      paymentCount: c.paymentCount,
    }))
    .sort(byMagnitude);

  const branches: OutgoingsBranch[] = [...byBranch.entries()]
    .map(([branchId, b]) => ({
      branchId,
      name: b.name,
      expense: money(b.expenseCents),
      payment: money(b.paymentCents),
      total: money(b.expenseCents + b.paymentCents),
      count: b.count,
    }))
    .sort((a, b) => b.total - a.total || (a.name ?? '').localeCompare(b.name ?? ''));

  return {
    rows: rowsOut,
    branches,
    summary: {
      totalOutgoings: money(expenseTotal + paymentTotal),
      expenseTotal: money(expenseTotal),
      paymentTotal: money(paymentTotal),
      count: expenseCount + paymentCount,
      expenseCount,
      paymentCount,
      branchCount: branches.length,
    },
  };
}
