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
}

export interface LoadingSourceRow {
  id: string;
  transaction_number?: number | string | null;
  created_at?: string | Date | null;
  total_revenue?: number | string | null;
  profit?: number | string | null;
  product_name?: string | null;
  account_name?: string | null;
  branch_name?: string | null;
}

// On top and inside are the two fee modes (D42's direction rule); loading is
// neither, because a loading sale earns its margin rather than charging a fee.
export type CashIncomeType = 'on-top' | 'inside' | 'loading';

export interface CashTransactionRow {
  id: string;
  kind: 'cash' | 'loading';
  // Manila day, `YYYY-MM-DD` — the grouping key the report sorts and prints by.
  day: string | null;
  reference: string | null;
  accountName: string | null;
  branchName: string | null;
  // The transaction type name for a cash movement, the product name for a
  // loading sale — what the row was, in the reader's own words.
  description: string | null;
  direction: string | null;
  // Cash: the movement amount. Loading: the selling price that reached the
  // drawer. Context beside the income, never summed into it.
  amount: number;
  // What the row earned the company: the fee (cash) or the margin (loading).
  income: number;
  incomeType: CashIncomeType;
}

export interface CashTransactionsSummary {
  feeOnTop: { total: number; count: number };
  feeInside: { total: number; count: number };
  loadingMargin: { total: number; count: number };
  totalIncome: number;
}

export interface CashTransactionsReport {
  rows: CashTransactionRow[];
  summary: CashTransactionsSummary;
}

export function buildCashTransactionsReport(
  cash: CashSourceRow[],
  loading: LoadingSourceRow[],
): CashTransactionsReport {
  let onTopCents = 0;
  let onTopCount = 0;
  let insideCents = 0;
  let insideCount = 0;
  let loadingCents = 0;
  let loadingCount = 0;

  const rows: CashTransactionRow[] = [
    ...cash.map((row) => {
      const feeCents = toCents(row.fee);
      // `false` is inside; true and NULL are on-top. The query only hands over
      // rows with a fee, so a mode here always names a fee that was charged.
      const incomeType: CashIncomeType = row.fee_added_to_balance === false ? 'inside' : 'on-top';
      if (incomeType === 'on-top') {
        onTopCents += feeCents;
        onTopCount += 1;
      } else {
        insideCents += feeCents;
        insideCount += 1;
      }

      return {
        id: row.id,
        kind: 'cash',
        day: asDay(row.transaction_date),
        reference: asReference(row.transaction_number),
        accountName: asText(row.account_name),
        branchName: asText(row.branch_name),
        description: asText(row.type_name),
        direction: asText(row.direction),
        amount: money(toCents(row.amount)),
        income: money(feeCents),
        incomeType,
      } satisfies CashTransactionRow;
    }),
    ...loading.map((row) => {
      const marginCents = toCents(row.profit);
      loadingCents += marginCents;
      loadingCount += 1;

      return {
        id: row.id,
        kind: 'loading',
        day: asDay(row.created_at),
        reference: asReference(row.transaction_number),
        accountName: asText(row.account_name),
        branchName: asText(row.branch_name),
        description: asText(row.product_name),
        direction: null,
        amount: money(toCents(row.total_revenue)),
        income: money(marginCents),
        incomeType: 'loading',
      } satisfies CashTransactionRow;
    }),
  ];

  // Newest first across both record types, so a loading sale and the cash
  // movement beside it interleave by the day they happened rather than one
  // block always preceding the other. A row with no date sinks to the bottom
  // instead of sorting unpredictably against real days.
  rows.sort((a, b) => {
    if (a.day === null && b.day === null) return 0;
    if (a.day === null) return 1;
    if (b.day === null) return -1;
    if (a.day !== b.day) return a.day < b.day ? 1 : -1;
    // Same day: cash before loading, then by reference, so the order is
    // reproducible between renders rather than depending on query arrival.
    if (a.kind !== b.kind) return a.kind === 'cash' ? -1 : 1;
    return (a.reference ?? '').localeCompare(b.reference ?? '');
  });

  const feeOnTop = money(onTopCents);
  const feeInside = money(insideCents);
  const loadingMargin = money(loadingCents);

  return {
    rows,
    summary: {
      feeOnTop: { total: feeOnTop, count: onTopCount },
      feeInside: { total: feeInside, count: insideCount },
      loadingMargin: { total: loadingMargin, count: loadingCount },
      // The three income types are disjoint — a fee is either on top or inside,
      // a loading sale is neither — so their sum is the whole of what the period
      // earned and never double-counts a peso. This is the figure the
      // dashboard's two cards add back to.
      totalIncome: money(onTopCents + insideCents + loadingCents),
    },
  };
}
