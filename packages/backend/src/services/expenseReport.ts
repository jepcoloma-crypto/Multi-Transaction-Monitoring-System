// Shapes per-account expense rows into the payload the expense report and its
// CSV export both render. Pure — no network, no database — so every component
// and subtotal is testable without one.
//
// The only expense this report carries is the service charge on a fund
// transfer. A transfer debits the sender the amount plus that charge and
// credits the receiver only the amount, so the difference leaves the account
// pool and is paid to the provider: money out, not money in. It was previously
// totalled as income, which would have counted the same peso on two reports
// once this one existed, so it appears here and is excluded from the income
// totals (see incomeReport.ts).
//
// Like the income report the figure is split into components rather than one
// number: a component the operator can see is a component they can reconcile
// against the transfer list. transferCount is every completed transfer sent by
// the account, fee or no fee, so the count on the row and the count behind the
// drill-down of the transfer report agree.

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

const asCount = (value: unknown): number => {
  const text = typeof value === 'number' ? String(value) : asText(value);
  if (text === null || !NUMERIC.test(text)) return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

export interface ExpenseSourceRow {
  account_id: string;
  account_name: string;
  provider_name?: string | null;
  account_type?: string | null;
  transfer_count?: number | string | null;
  transfer_service_fee?: number | string | null;
}

export interface ExpenseReportRow {
  accountId: string;
  accountName: string;
  providerName: string | null;
  accountType: string | null;
  transferCount: number;
  serviceFees: number;
  totalExpense: number;
}

export interface ExpenseSummary {
  accounts: number;
  payingAccounts: number;
  transferCount: number;
  serviceFees: number;
  totalExpense: number;
}

export interface ExpenseReport {
  rows: ExpenseReportRow[];
  summary: ExpenseSummary;
}

export function buildExpenseReport(sourceRows: ExpenseSourceRow[]): ExpenseReport {
  let transferCount = 0;
  let serviceFeesCents = 0;
  let payingAccounts = 0;

  const rows = sourceRows.map((row) => {
    const rowServiceCents = toCents(row.transfer_service_fee);
    // With one component the two figures agree by construction; they are kept
    // separate so a later expense can be added without changing the shape, and
    // so the row still reads component-then-total like the income report does.
    const rowTotalCents = rowServiceCents;

    transferCount += asCount(row.transfer_count);
    serviceFeesCents += rowServiceCents;
    if (rowTotalCents > 0) payingAccounts += 1;

    return {
      accountId: row.account_id,
      accountName: asText(row.account_name) ?? row.account_id,
      providerName: asText(row.provider_name),
      accountType: asText(row.account_type),
      transferCount: asCount(row.transfer_count),
      serviceFees: money(rowServiceCents),
      totalExpense: money(rowTotalCents),
    } satisfies ExpenseReportRow;
  });

  // Largest spender first, then by name so two accounts on the same figure do
  // not swap places between renders.
  rows.sort((a, b) => b.totalExpense - a.totalExpense || a.accountName.localeCompare(b.accountName));

  return {
    rows,
    summary: {
      accounts: rows.length,
      payingAccounts,
      transferCount,
      serviceFees: money(serviceFeesCents),
      totalExpense: money(serviceFeesCents),
    },
  };
}

const asDate = (value: unknown): string | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = asText(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

const asIdentifier = (value: unknown): number | null => {
  const text = typeof value === 'number' ? String(value) : asText(value);
  if (text === null || !NUMERIC.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

export interface ExpenseDetailSourceRow {
  id: string;
  transfer_number?: number | string | null;
  transfer_reference?: string | null;
  transfer_date?: string | Date | null;
  destination_name?: string | null;
  transfer_amount?: number | string | null;
  transfer_fee?: number | string | null;
}

export interface ExpenseDetailRow {
  id: string;
  transferNumber: number | null;
  transferReference: string | null;
  transferDate: string | null;
  destinationName: string | null;
  amount: number;
  fee: number;
}

export interface ExpenseDetail {
  rows: ExpenseDetailRow[];
  summary: {
    transferCount: number;
    transferAmount: number;
    serviceFees: number;
  };
}

// The detail sums its own totals from the rows it was handed rather than
// copying the account row's figures down. The account row's serviceFees comes
// from an aggregate over transfers; these come from the individual rows
// fetched for one account. Two independently computed figures either agree or
// visibly do not, which is the only way a drill-down can ever prove the number
// above it instead of merely restating it.
//
// transferCount covers every completed transfer the account sent, fee or no
// fee, because that is what the account row's Transfers column counts; service
// fees then total the fees on those same rows, which is what its service fees
// total. Matching both means neither figure can be right by accident.
export function buildExpenseDetail(sourceRows: ExpenseDetailSourceRow[]): ExpenseDetail {
  let transferAmountCents = 0;
  let serviceFeesCents = 0;

  const rows: ExpenseDetailRow[] = sourceRows.map((row) => {
    const amountCents = toCents(row.transfer_amount);
    const feeCents = toCents(row.transfer_fee);
    transferAmountCents += amountCents;
    serviceFeesCents += feeCents;

    return {
      id: row.id,
      transferNumber: asIdentifier(row.transfer_number),
      transferReference: asText(row.transfer_reference),
      transferDate: asDate(row.transfer_date),
      destinationName: asText(row.destination_name),
      amount: money(amountCents),
      fee: money(feeCents),
    } satisfies ExpenseDetailRow;
  });

  return {
    rows,
    summary: {
      transferCount: rows.length,
      transferAmount: money(transferAmountCents),
      serviceFees: money(serviceFeesCents),
    },
  };
}
