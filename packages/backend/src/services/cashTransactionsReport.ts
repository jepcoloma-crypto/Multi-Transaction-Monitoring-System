// Shapes the cash-transactions report: the fee income split by where it lands
// (on top of the amount vs inside it), plus the loading sales that reach the
// drawer as margin. Pure — no network, no database — so every figure is
// testable without one.
//
// Two record types on purpose. A loading sale is not a transaction (it lives in
// `loading_transactions`), yet both a cash movement and a loading sale put money
// in the till and both carry income this report exists to break out. The whole
// report is the detail behind the dashboard's two income cards: on-top fees and
// loading margin are cash-on-hand money, inside fees are non-cash. Summing the
// three income types reproduces `totalIncome`, so a reader can tie the report
// back to the card without trusting a figure they cannot reconstruct.
//
// Money is held as integer cents end to end. pg hands numeric over as strings
// and a float adder drifts (0.10 + 0.05 is 0.15000000000000002), which is
// exactly the kind of error a printed total should make impossible.

import { manilaDateKey } from './manilaTime';

const NUMERIC = /^-?\d+(\.\d+)?$/;

const toCents = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : 0;
  if (typeof value !== 'string') return 0;
  const trimmed = value.trim();
  return NUMERIC.test(trimmed) ? Math.round(Number(trimmed) * 100) : 0;
};

const money = (cents: number): number => cents / 100;

const asText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const asIdentifier = (value: unknown): number | null => {
  const text = typeof value === 'number' ? String(value) : asText(value);
  if (text === null || !NUMERIC.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

// The transaction number as it prints on a row — `49690`, not `49690.0` — and
// null when the record carried none, so the cell can show a dash rather than a
// fabricated zero.
const asReference = (value: unknown): string | null => {
  const parsed = asIdentifier(value);
  return parsed === null ? null : String(parsed);
};

// The external reference as it prints — kept verbatim, because a code like
// `389A2` carries meaning a numeric cast would strip. Null when absent.
const asReferenceNumber = (value: unknown): string | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  return asText(value);
};

// The Manila calendar day an instant falls on. Every date a report row prints
// goes through the operating clock, so a transaction recorded at 23:30 Manila
// files under the day the operator worked, not the UTC day it would otherwise
// resolve to — one day early.
const asDay = (value: unknown): string | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : manilaDateKey(value);
  const text = asText(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : manilaDateKey(new Date(parsed));
};

export interface CashSourceRow {
  id: string;
  transaction_number?: number | string | null;
  // The external reference the customer or provider recognises (a GCash code,
  // say) — distinct from the system's own `transaction_number`.
  reference_number?: string | number | null;
  transaction_date?: string | Date | null;
  amount?: number | string | null;
  fee?: number | string | null;
  // The record of whether the customer paid the fee on top of the amount or
  // inside it. Anything but false reads as on-top, the same way `amountFields`
  // and the ledger treat it — a NULL predates the flag and charged on top.
  fee_added_to_balance?: boolean | null;
  direction?: string | null;
  type_name?: string | null;
  account_name?: string | null;
  branch_name?: string | null;
  // The charges folded into `amount`, pre-summed by the query as a numeric
  // (same guard the income report uses). Missing reads as zero.
  additional_charges?: number | string | null;
}

// The provider interest credited in the period. No fee, no charges and no
// direction: a credit the provider simply made, counted at the whole amount.
export interface InterestSourceRow {
  id: string;
  transaction_number?: number | string | null;
  reference_number?: string | number | null;
  transaction_date?: string | Date | null;
  type_name?: string | null;
  account_name?: string | null;
  branch_name?: string | null;
  // The whole credited amount — this row's income, with nothing to net off it.
  amount?: number | string | null;
}

export interface LoadingSourceRow {
  id: string;
  transaction_number?: number | string | null;
  reference_number?: string | number | null;
  created_at?: string | Date | null;
  total_revenue?: number | string | null;
  profit?: number | string | null;
  product_name?: string | null;
  account_name?: string | null;
  branch_name?: string | null;
}

// On top and inside are the two fee modes (the tender's own record, posted per
// D46); loading is neither, because a loading sale earns its margin rather than
// charging a fee; provider interest is a fourth thing again — money the
// provider credited the company, of which the whole peso is the income.
export type CashIncomeType = 'on-top' | 'inside' | 'loading' | 'provider-interest';

// The four are disjoint, and this is the order a same-day page lists them in:
// the transactions first, then the loading sales that happen to share the day.
const KIND_RANK: Record<CashTransactionRow['kind'], number> = { cash: 0, interest: 1, loading: 2 };

export interface CashTransactionRow {
  id: string;
  kind: 'cash' | 'interest' | 'loading';
  // Manila day, `YYYY-MM-DD` — the grouping key the report sorts and prints by.
  day: string | null;
  // The system's own sequential number, and the external reference beside it —
  // two different numbers an operator reconciles against, so neither stands in
  // for the other.
  transactionNumber: string | null;
  referenceNumber: string | null;
  accountName: string | null;
  branchName: string | null;
  // The transaction type name for a cash movement, the product name for a
  // loading sale — what the row was, in the reader's own words.
  description: string | null;
  direction: string | null;
  // Cash: the movement amount. Interest: the credited amount, which is also its
  // income. Loading: the selling price that reached the drawer. Context beside
  // the income, never summed into it.
  amount: number;
  // The additional charges riding inside `amount` — the customer's own money
  // (a Home Credit cut, say) that passed through rather than earned. Shown for
  // reconciliation, deliberately outside every income figure below.
  charges: number;
  // What the row earned the company: the fee (cash), the whole credit
  // (interest) or the margin (loading).
  income: number;
  incomeType: CashIncomeType;
}

export interface CashTransactionsSummary {
  feeOnTop: { total: number; count: number };
  feeInside: { total: number; count: number };
  loadingMargin: { total: number; count: number };
  providerInterest: { total: number; count: number };
  totalIncome: number;
  // Summed from the surviving rows like every other figure here — reference
  // only, so `totalIncome` never carries a peso of it.
  charges: number;
}

export interface CashTransactionsReport {
  rows: CashTransactionRow[];
  summary: CashTransactionsSummary;
}

export function buildCashTransactionsReport(
  cash: CashSourceRow[],
  loading: LoadingSourceRow[],
  handling?: CashIncomeType | null,
  interest?: InterestSourceRow[],
): CashTransactionsReport {
  const allRows: CashTransactionRow[] = [
    ...cash.map((row) => {
      const feeCents = toCents(row.fee);
      // `false` is inside; true and NULL are on-top. The query only hands over
      // rows with a fee, so a mode here always names a fee that was charged.
      const incomeType: CashIncomeType = row.fee_added_to_balance === false ? 'inside' : 'on-top';

      return {
        id: row.id,
        kind: 'cash',
        day: asDay(row.transaction_date),
        transactionNumber: asReference(row.transaction_number),
        referenceNumber: asReferenceNumber(row.reference_number),
        accountName: asText(row.account_name),
        branchName: asText(row.branch_name),
        description: asText(row.type_name),
        direction: asText(row.direction),
        amount: money(toCents(row.amount)),
        charges: money(toCents(row.additional_charges)),
        income: money(feeCents),
        incomeType,
      } satisfies CashTransactionRow;
    }),
    ...(interest ?? []).map((row) => {
      const amountCents = toCents(row.amount);

      return {
        id: row.id,
        kind: 'interest',
        day: asDay(row.transaction_date),
        transactionNumber: asReference(row.transaction_number),
        referenceNumber: asReferenceNumber(row.reference_number),
        accountName: asText(row.account_name),
        branchName: asText(row.branch_name),
        description: asText(row.type_name),
        direction: null,
        amount: money(amountCents),
        // An interest credit carries no charges — nothing was billed alongside
        // it, the provider simply paid the company.
        charges: 0,
        income: money(amountCents),
        incomeType: 'provider-interest',
      } satisfies CashTransactionRow;
    }),
    ...loading.map((row) => {
      const marginCents = toCents(row.profit);

      return {
        id: row.id,
        kind: 'loading',
        day: asDay(row.created_at),
        transactionNumber: asReference(row.transaction_number),
        referenceNumber: asReferenceNumber(row.reference_number),
        accountName: asText(row.account_name),
        branchName: asText(row.branch_name),
        description: asText(row.product_name),
        direction: null,
        amount: money(toCents(row.total_revenue)),
        // A loading sale has no `additional_charges` of its own — the product's
        // company charge is already priced into the revenue above.
        charges: 0,
        income: money(marginCents),
        incomeType: 'loading',
      } satisfies CashTransactionRow;
    }),
  ];

  // The handling drill-down narrows the list, and the summary below is summed
  // from whatever survives — so the figures always add up to the rows on screen,
  // even mid-filter. A summary that kept the unfiltered totals would print a
  // number a reader cannot reach by adding the rows they can see.
  const rows = handling ? allRows.filter((row) => row.incomeType === handling) : allRows;

  // Newest first across both record types, so a loading sale and the cash
  // movement beside it interleave by the day they happened rather than one
  // block always preceding the other. A row with no date sinks to the bottom
  // instead of sorting unpredictably against real days.
  rows.sort((a, b) => {
    if (a.day === null && b.day === null) return 0;
    if (a.day === null) return 1;
    if (b.day === null) return -1;
    if (a.day !== b.day) return a.day < b.day ? 1 : -1;
    // Same day: the transactions before the loading sales that share it, with
    // interest credit sitting beside the movement it resembles rather than
    // after it — then by the system's own number, so the order is reproducible
    // between renders instead of depending on query arrival.
    if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    return (a.transactionNumber ?? '').localeCompare(b.transactionNumber ?? '');
  });

  let onTopCents = 0;
  let onTopCount = 0;
  let insideCents = 0;
  let insideCount = 0;
  let loadingCents = 0;
  let loadingCount = 0;
  let interestCents = 0;
  let interestCount = 0;
  let chargesCents = 0;
  for (const row of rows) {
    const cents = toCents(row.income);
    chargesCents += toCents(row.charges);
    // Named on the last branch rather than left as a bare `else`: a fifth type
    // added later would otherwise land in whichever bucket happened to be
    // final, and the summary would total it under a name that is not its own.
    if (row.incomeType === 'on-top') {
      onTopCents += cents;
      onTopCount += 1;
    } else if (row.incomeType === 'inside') {
      insideCents += cents;
      insideCount += 1;
    } else if (row.incomeType === 'provider-interest') {
      interestCents += cents;
      interestCount += 1;
    } else {
      loadingCents += cents;
      loadingCount += 1;
    }
  }

  return {
    rows,
    summary: {
      feeOnTop: { total: money(onTopCents), count: onTopCount },
      feeInside: { total: money(insideCents), count: insideCount },
      loadingMargin: { total: money(loadingCents), count: loadingCount },
      providerInterest: { total: money(interestCents), count: interestCount },
      // The four income types are disjoint — a fee is either on top or inside,
      // a loading sale is neither, and interest is a credit rather than a
      // charge — so their sum is the whole of what the period earned and never
      // double-counts a peso. This is the figure the dashboard's two cards add
      // back to.
      totalIncome: money(onTopCents + insideCents + loadingCents + interestCents),
      charges: money(chargesCents),
    },
  };
}
