// Shapes per-account expense rows into the payload the expense report and its
// CSV export both render. Pure — no network, no database — so every component
// and subtotal is testable without one.
//
// Two expenses, sharing the property that is the whole reason each is an
// expense: a debit with no credit anywhere in the account pool, so the money
// is gone rather than merely moved.
//
//   service fees       the charge on a fund transfer. A transfer debits the
//                      sender the amount plus that charge and credits the
//                      receiver only the amount, so the difference is paid to
//                      the provider. It was previously totalled as income,
//                      which would have counted the same peso on two reports
//                      once this one existed, so it appears here and is
//                      excluded from the income totals (see incomeReport.ts).
//
//   provider charges   a charge the provider deducts straight from the balance
//                      on a cash-in or a cash-out. The customer is never
//                      billed for it, so it is written as its own linked
//                      expense row rather than folded into the cash
//                      transaction (migration 032) and until now reached no
//                      report at all.
//
// Like the income report the figure is split into components rather than one
// number: a component the operator can see is a component they can reconcile.
// transferCount is every completed transfer sent by the account, fee or no
// fee, so the count on the row and the count behind the drill-down agree.

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
  provider_charges?: number | string | null;
  operating_expenses?: number | string | null;
}

export interface ExpenseReportRow {
  accountId: string;
  accountName: string;
  providerName: string | null;
  accountType: string | null;
  transferCount: number;
  serviceFees: number;
  providerCharges: number;
  operatingExpenses: number;
  totalExpense: number;
}

export interface ExpenseSummary {
  accounts: number;
  payingAccounts: number;
  transferCount: number;
  serviceFees: number;
  providerCharges: number;
  operatingExpenses: number;
  totalExpense: number;
}

export interface ExpenseReport {
  rows: ExpenseReportRow[];
  summary: ExpenseSummary;
}

export function buildExpenseReport(sourceRows: ExpenseSourceRow[]): ExpenseReport {
  let transferCount = 0;
  let serviceFeesCents = 0;
  let providerChargesCents = 0;
  let operatingExpensesCents = 0;
  let payingAccounts = 0;

  const rows = sourceRows.map((row) => {
    const rowServiceCents = toCents(row.transfer_service_fee);
    const rowProviderCents = toCents(row.provider_charges);
    const rowOperatingCents = toCents(row.operating_expenses);
    // All three components are summed here rather than one arriving
    // pre-totalled, so each can be checked against the list behind it — service
    // fees against the transfers, provider charges against the expense rows,
    // operating expenses against the cash they left — and a total that
    // disagreed with its own components would show rather than reconcile with
    // itself by construction.
    const rowTotalCents = rowServiceCents + rowProviderCents + rowOperatingCents;

    transferCount += asCount(row.transfer_count);
    serviceFeesCents += rowServiceCents;
    providerChargesCents += rowProviderCents;
    operatingExpensesCents += rowOperatingCents;
    if (rowTotalCents > 0) payingAccounts += 1;

    return {
      accountId: row.account_id,
      accountName: asText(row.account_name) ?? row.account_id,
      providerName: asText(row.provider_name),
      accountType: asText(row.account_type),
      transferCount: asCount(row.transfer_count),
      serviceFees: money(rowServiceCents),
      providerCharges: money(rowProviderCents),
      operatingExpenses: money(rowOperatingCents),
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
      providerCharges: money(providerChargesCents),
      operatingExpenses: money(operatingExpensesCents),
      totalExpense: money(serviceFeesCents + providerChargesCents + operatingExpensesCents),
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

export interface ExpenseChargeSourceRow {
  id: string;
  transaction_number?: number | string | null;
  transaction_date?: string | Date | null;
  description?: string | null;
  amount?: number | string | null;
  linked_transaction_number?: number | string | null;
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

export interface ExpenseChargeRow {
  id: string;
  transactionNumber: number | null;
  transactionDate: string | null;
  description: string | null;
  amount: number;
  linkedTransactionNumber: number | null;
}

export interface ExpenseOperatingSourceRow {
  id: string;
  transaction_number?: number | string | null;
  transaction_date?: string | Date | null;
  description?: string | null;
  payee?: string | null;
  amount?: number | string | null;
}

export interface ExpenseOperatingRow {
  id: string;
  transactionNumber: number | null;
  transactionDate: string | null;
  description: string | null;
  payee: string | null;
  amount: number;
}

export interface ExpenseDetail {
  transfers: ExpenseDetailRow[];
  charges: ExpenseChargeRow[];
  operating: ExpenseOperatingRow[];
  summary: {
    transferCount: number;
    transferAmount: number;
    serviceFees: number;
    chargeCount: number;
    providerCharges: number;
    operatingCount: number;
    operatingExpenses: number;
    totalExpense: number;
  };
}

export interface ExpenseDetailSource {
  transfers: ExpenseDetailSourceRow[];
  charges: ExpenseChargeSourceRow[];
  operating: ExpenseOperatingSourceRow[];
}

// The detail sums its own totals from the rows it was handed rather than
// copying the account row's figures down. The account row's serviceFees comes
// from an aggregate over transfers and its providerCharges from one over
// expense transactions; these come from the individual rows fetched for one
// account. Two independently computed figures either agree or visibly do not,
// which is the only way a drill-down can ever prove the number above it
// instead of merely restating it.
//
// transferCount covers every completed transfer the account sent, fee or no
// fee, because that is what the account row's Transfers column counts;
// chargeCount likewise counts every provider charge so both component columns
// reconcile. totalExpense is summed from both components rather than taken
// from the account row, so the drill-down reconciles with the report row by
// addition and not by mirroring it.
//
// All three source sets are required. A default of `[]` would let a missing
// argument quietly produce a drill-down that under-reports what the row above
// it claims — the exact disagreement this function exists to detect.
export function buildExpenseDetail(source: ExpenseDetailSource): ExpenseDetail {
  let transferAmountCents = 0;
  let serviceFeesCents = 0;
  let providerChargesCents = 0;
  let operatingCents = 0;

  // Left in the order the queries returned: all are ordered newest first, so
  // the panels sit in the same convention and none can appear to disagree with
  // another because one happens to be ascending.
  const transfers: ExpenseDetailRow[] = source.transfers.map((row) => {
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

  const charges: ExpenseChargeRow[] = source.charges.map((row) => {
    const amountCents = toCents(row.amount);
    providerChargesCents += amountCents;

    return {
      id: row.id,
      transactionNumber: asIdentifier(row.transaction_number),
      transactionDate: asDate(row.transaction_date),
      description: asText(row.description),
      amount: money(amountCents),
      linkedTransactionNumber: asIdentifier(row.linked_transaction_number),
    } satisfies ExpenseChargeRow;
  });

  const operating: ExpenseOperatingRow[] = source.operating.map((row) => {
    const amountCents = toCents(row.amount);
    operatingCents += amountCents;

    return {
      id: row.id,
      transactionNumber: asIdentifier(row.transaction_number),
      transactionDate: asDate(row.transaction_date),
      description: asText(row.description),
      payee: asText(row.payee),
      amount: money(amountCents),
    } satisfies ExpenseOperatingRow;
  });

  return {
    transfers,
    charges,
    operating,
    summary: {
      transferCount: transfers.length,
      transferAmount: money(transferAmountCents),
      serviceFees: money(serviceFeesCents),
      chargeCount: charges.length,
      providerCharges: money(providerChargesCents),
      operatingCount: operating.length,
      operatingExpenses: money(operatingCents),
      totalExpense: money(serviceFeesCents + providerChargesCents + operatingCents),
    },
  };
}
