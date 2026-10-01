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

// The tree behind one account row. The footer totals are summed from the rows
// being displayed rather than copied down from the parent, so a tab that has
// drifted away from the figure it explains shows up as a disagreement between
// two numbers the operator can see, instead of hiding behind one number
// written twice.

const asDate = (value: unknown): string | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = asText(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

const asNumber = (value: unknown): number => {
  const text = typeof value === 'number' ? String(value) : asText(value);
  if (text === null || !NUMERIC.test(text)) return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
};

const asIdentifier = (value: unknown): number | null => {
  const text = typeof value === 'number' ? String(value) : asText(value);
  if (text === null || !NUMERIC.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

export interface CashDetailSource {
  id: string;
  transaction_number?: number | string | null;
  reference_number?: string | null;
  transaction_date?: string | Date | null;
  type_name?: string | null;
  direction?: string | null;
  description?: string | null;
  status?: string | null;
  amount?: number | string | null;
  fee?: number | string | null;
  charges?: number | string | null;
}

export interface CashDetailRow {
  id: string;
  transactionNumber: number | null;
  referenceNumber: string | null;
  transactionDate: string | null;
  typeName: string | null;
  direction: string | null;
  description: string | null;
  status: string | null;
  isReversed: boolean;
  amount: number;
  fee: number;
  charges: number;
  feeCharges: number;
}

export interface LoadingDetailSource {
  id: string;
  transaction_number?: number | string | null;
  created_at?: string | Date | null;
  product_name?: string | null;
  customer_number?: string | null;
  quantity?: number | string | null;
  total_revenue?: number | string | null;
  total_cost?: number | string | null;
  profit?: number | string | null;
}

export interface LoadingDetailRow {
  id: string;
  transactionNumber: number | null;
  createdAt: string | null;
  productName: string | null;
  customerNumber: string | null;
  quantity: number;
  revenue: number;
  cost: number;
  margin: number;
}

export interface TransferDetailSource {
  id: string;
  transfer_number?: number | string | null;
  transfer_reference?: string | null;
  transfer_date?: string | Date | null;
  destination_name?: string | null;
  transfer_amount?: number | string | null;
  transfer_fee?: number | string | null;
}

export interface TransferDetailRow {
  id: string;
  transferNumber: number | null;
  transferReference: string | null;
  transferDate: string | null;
  destinationName: string | null;
  amount: number;
  fee: number;
}

export interface IncomeDetailSummary {
  cashCount: number;
  cashCompletedCount: number;
  cashReversedCount: number;
  earnedFee: number;
  earnedCharges: number;
  earned: number;
  refundedFee: number;
  refundedCharges: number;
  refunded: number;
  loadingCount: number;
  loadRevenue: number;
  loadCost: number;
  loadMargin: number;
  transferCount: number;
  transferAmount: number;
  transferFees: number;
}

export interface IncomeDetail {
  cash: CashDetailRow[];
  loading: LoadingDetailRow[];
  transfers: TransferDetailRow[];
  summary: IncomeDetailSummary;
}

export function buildIncomeDetail(source: {
  cash?: CashDetailSource[];
  loading?: LoadingDetailSource[];
  transfers?: TransferDetailSource[];
}): IncomeDetail {
  let cashCompletedCount = 0;
  let cashReversedCount = 0;
  let earnedFeeCents = 0;
  let earnedChargesCents = 0;
  let refundedFeeCents = 0;
  let refundedChargesCents = 0;

  // A reversed transaction's fee was refunded, so it is totalled separately
  // instead of being dropped: the parent row prints both figures, and a tab
  // that silently omitted the refunded half would make the two disagree.
  const cash: CashDetailRow[] = (source.cash ?? []).map((row) => {
    const feeCents = toCents(row.fee);
    const chargesCents = toCents(row.charges);
    const status = asText(row.status);
    if (status === 'reversed') {
      cashReversedCount += 1;
      refundedFeeCents += feeCents;
      refundedChargesCents += chargesCents;
    } else if (status === 'completed') {
      cashCompletedCount += 1;
      earnedFeeCents += feeCents;
      earnedChargesCents += chargesCents;
    }

    return {
      id: row.id,
      transactionNumber: asIdentifier(row.transaction_number),
      referenceNumber: asText(row.reference_number),
      transactionDate: asDate(row.transaction_date),
      typeName: asText(row.type_name),
      direction: asText(row.direction),
      description: asText(row.description),
      status,
      isReversed: status === 'reversed',
      amount: money(toCents(row.amount)),
      fee: money(feeCents),
      charges: money(chargesCents),
      feeCharges: money(feeCents + chargesCents),
    } satisfies CashDetailRow;
  });

  let loadRevenueCents = 0;
  let loadCostCents = 0;
  let loadMarginCents = 0;

  const loading: LoadingDetailRow[] = (source.loading ?? []).map((row) => {
    const revenueCents = toCents(row.total_revenue);
    const costCents = toCents(row.total_cost);
    const marginCents = toCents(row.profit);
    loadRevenueCents += revenueCents;
    loadCostCents += costCents;
    loadMarginCents += marginCents;

    return {
      id: row.id,
      transactionNumber: asIdentifier(row.transaction_number),
      createdAt: asDate(row.created_at),
      productName: asText(row.product_name),
      customerNumber: asText(row.customer_number),
      quantity: asNumber(row.quantity),
      revenue: money(revenueCents),
      cost: money(costCents),
      margin: money(marginCents),
    } satisfies LoadingDetailRow;
  });

  let transferAmountCents = 0;
  let transferFeeCents = 0;

  const transfers: TransferDetailRow[] = (source.transfers ?? []).map((row) => {
    const amountCents = toCents(row.transfer_amount);
    const feeCents = toCents(row.transfer_fee);
    transferAmountCents += amountCents;
    transferFeeCents += feeCents;

    return {
      id: row.id,
      transferNumber: asIdentifier(row.transfer_number),
      transferReference: asText(row.transfer_reference),
      transferDate: asDate(row.transfer_date),
      destinationName: asText(row.destination_name),
      amount: money(amountCents),
      fee: money(feeCents),
    } satisfies TransferDetailRow;
  });

  return {
    cash,
    loading,
    transfers,
    summary: {
      cashCount: cash.length,
      cashCompletedCount,
      cashReversedCount,
      earnedFee: money(earnedFeeCents),
      earnedCharges: money(earnedChargesCents),
      earned: money(earnedFeeCents + earnedChargesCents),
      refundedFee: money(refundedFeeCents),
      refundedCharges: money(refundedChargesCents),
      refunded: money(refundedFeeCents + refundedChargesCents),
      loadingCount: loading.length,
      loadRevenue: money(loadRevenueCents),
      loadCost: money(loadCostCents),
      loadMargin: money(loadMarginCents),
      transferCount: transfers.length,
      transferAmount: money(transferAmountCents),
      transferFees: money(transferFeeCents),
    },
  };
}
