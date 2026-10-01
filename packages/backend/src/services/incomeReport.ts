// Shapes per-account income rows into the payload the income report and its
// CSV export both render. Pure — no network, no database — so every component
// and subtotal is testable without one.
//
// Income is deliberately split into components rather than one number. A
// component the operator can see is a component they can reconcile against the
// source table; a single blended figure is a number they have to trust.

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

export interface IncomeSourceRow {
  account_id: string;
  account_name: string;
  provider_name?: string | null;
  account_type?: string | null;
  txn_count?: number | string | null;
  txn_fees?: number | string | null;
  additional_charges?: number | string | null;
  reversed_excluded?: number | string | null;
  transfer_count?: number | string | null;
  transfer_fees?: number | string | null;
  load_count?: number | string | null;
  load_revenue?: number | string | null;
  load_cost?: number | string | null;
  load_margin?: number | string | null;
}

export interface IncomeReportRow {
  accountId: string;
  accountName: string;
  providerName: string | null;
  accountType: string | null;
  txnCount: number;
  transferCount: number;
  loadCount: number;
  txnFees: number;
  additionalCharges: number;
  transferFees: number;
  feeIncome: number;
  loadRevenue: number;
  loadCost: number;
  loadMargin: number;
  totalIncome: number;
  reversedExcluded: number;
}

export interface IncomeSummary {
  accounts: number;
  earningAccounts: number;
  txnCount: number;
  transferCount: number;
  loadCount: number;
  txnFees: number;
  additionalCharges: number;
  transferFees: number;
  feeIncome: number;
  loadRevenue: number;
  loadCost: number;
  loadMargin: number;
  totalIncome: number;
  reversedExcluded: number;
}

export interface IncomeReport {
  rows: IncomeReportRow[];
  summary: IncomeSummary;
}

export function buildIncomeReport(sourceRows: IncomeSourceRow[]): IncomeReport {
  let txnCount = 0;
  let transferCount = 0;
  let loadCount = 0;
  let txnFeesCents = 0;
  let chargesCents = 0;
  let transferFeesCents = 0;
  let loadRevenueCents = 0;
  let loadCostCents = 0;
  let loadMarginCents = 0;
  let reversedCents = 0;
  let earningAccounts = 0;

  const rows = sourceRows.map((row) => {
    const rowTxnFeesCents = toCents(row.txn_fees);
    const rowChargesCents = toCents(row.additional_charges);
    const rowTransferFeesCents = toCents(row.transfer_fees);
    const rowFeeCents = rowTxnFeesCents + rowChargesCents + rowTransferFeesCents;
    const rowLoadMarginCents = toCents(row.load_margin);
    const rowTotalCents = rowFeeCents + rowLoadMarginCents;

    txnCount += asCount(row.txn_count);
    transferCount += asCount(row.transfer_count);
    loadCount += asCount(row.load_count);
    txnFeesCents += rowTxnFeesCents;
    chargesCents += rowChargesCents;
    transferFeesCents += rowTransferFeesCents;
    loadRevenueCents += toCents(row.load_revenue);
    loadCostCents += toCents(row.load_cost);
    loadMarginCents += rowLoadMarginCents;
    reversedCents += toCents(row.reversed_excluded);
    if (rowTotalCents > 0) earningAccounts += 1;

    return {
      accountId: row.account_id,
      accountName: asText(row.account_name) ?? row.account_id,
      providerName: asText(row.provider_name),
      accountType: asText(row.account_type),
      txnCount: asCount(row.txn_count),
      transferCount: asCount(row.transfer_count),
      loadCount: asCount(row.load_count),
      txnFees: money(rowTxnFeesCents),
      additionalCharges: money(rowChargesCents),
      transferFees: money(rowTransferFeesCents),
      feeIncome: money(rowFeeCents),
      loadRevenue: money(toCents(row.load_revenue)),
      loadCost: money(toCents(row.load_cost)),
      loadMargin: money(rowLoadMarginCents),
      totalIncome: money(rowTotalCents),
      reversedExcluded: money(toCents(row.reversed_excluded)),
    } satisfies IncomeReportRow;
  });

  // Largest earner first, then by name so two accounts on the same figure do
  // not swap places between renders.
  rows.sort((a, b) => b.totalIncome - a.totalIncome || a.accountName.localeCompare(b.accountName));

  return {
    rows,
    summary: {
      accounts: rows.length,
      earningAccounts,
      txnCount,
      transferCount,
      loadCount,
      txnFees: money(txnFeesCents),
      additionalCharges: money(chargesCents),
      transferFees: money(transferFeesCents),
      feeIncome: money(txnFeesCents + chargesCents + transferFeesCents),
      loadRevenue: money(loadRevenueCents),
      loadCost: money(loadCostCents),
      loadMargin: money(loadMarginCents),
      totalIncome: money(txnFeesCents + chargesCents + transferFeesCents + loadMarginCents),
      reversedExcluded: money(reversedCents),
    },
  };
}
