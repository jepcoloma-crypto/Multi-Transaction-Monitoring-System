import { formatCurrency } from '../lib/format';

export type IncomeDetailTab = 'cash' | 'loading' | 'transfers';

export interface IncomeParentRow {
  txnFees: number;
  additionalCharges: number;
  transferFees: number;
  loadMargin: number;
  reversedExcluded: number;
}

interface CashRow {
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

interface LoadingRow {
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

interface TransferRow {
  id: string;
  transferNumber: number | null;
  transferReference: string | null;
  transferDate: string | null;
  destinationName: string | null;
  amount: number;
  fee: number;
}

interface Detail {
  cash: CashRow[];
  loading: LoadingRow[];
  transfers: TransferRow[];
  summary: {
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
  };
}

interface Props {
  detail: Detail;
  tab: IncomeDetailTab;
  onTab: (tab: IncomeDetailTab) => void;
  parent: IncomeParentRow;
}

const TABS: { id: IncomeDetailTab; label: string }[] = [
  { id: 'cash', label: 'Cash Transactions' },
  { id: 'loading', label: 'Loading' },
  { id: 'transfers', label: 'Transfers' },
];

const th = 'px-3 py-2 text-xs font-medium text-gray-500 uppercase whitespace-nowrap';
const thRight = `${th} text-right`;
const td = 'px-3 py-2 text-sm whitespace-nowrap';
const tdRight = `${td} text-right font-mono`;

const dateLabel = (value: string | null): string =>
  value ? new Date(value).toLocaleDateString() : '—';

const numberLabel = (value: number | null): string =>
  value === null ? '—' : `#${value}`;

const countFor = (detail: Detail, tab: IncomeDetailTab): number =>
  tab === 'cash' ? detail.summary.cashCount
    : tab === 'loading' ? detail.summary.loadingCount
      : detail.summary.transferCount;

// Every tab prints the number its rows total next to the number on the account
// row above. Agreeing is the expected case and says so quietly; disagreeing is
// a bug the operator should see as a bug, not as a figure to second-guess.
const Reconciles = ({ label, expected, actual }: { label: string; expected: number; actual: number }) => {
  const matches = Math.abs(expected - actual) < 0.005;
  return (
    <p className={matches ? 'text-finance-green' : 'text-amber-600 font-medium'}>
      {matches
        ? `Reconciles with the account row — ${label} ${formatCurrency(expected)}`
        : `Does not reconcile — account row shows ${label} ${formatCurrency(expected)}, these rows total ${formatCurrency(actual)}`}
    </p>
  );
};

const EmptyTab = ({ tab }: { tab: IncomeDetailTab }) => (
  <p className="text-sm text-gray-500 py-6 text-center">
    {tab === 'cash' && 'No cash transactions for this account in the selected period.'}
    {tab === 'loading' && 'No loading transactions for this account in the selected period.'}
    {tab === 'transfers' && 'No transfers funded from this account in the selected period.'}
  </p>
);

const CashTable = ({ rows, summary, parent }: { rows: CashRow[]; summary: Detail['summary']; parent: IncomeParentRow }) => (
  <>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1100px]">
        <thead className="bg-gray-100">
          <tr>
            <th className={th}>Txn #</th>
            <th className={th}>Date</th>
            <th className={th}>Status</th>
            <th className={th}>Type</th>
            <th className={th}>Reference</th>
            <th className={th}>Description</th>
            <th className={thRight}>Amount</th>
            <th className={thRight}>Fee</th>
            <th className={thRight}>Charges</th>
            <th className={thRight}>Fee + Charges</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.id} className={r.isReversed ? 'bg-amber-50' : ''}>
              <td className={`${td} font-medium`}>{numberLabel(r.transactionNumber)}</td>
              <td className={td}>{dateLabel(r.transactionDate)}</td>
              <td className={td}>
                <span className={r.isReversed ? 'text-amber-600 font-medium' : 'text-gray-500'}>{r.status || '—'}</span>
              </td>
              <td className={td}>{r.typeName || '—'}</td>
              <td className={`${td} font-mono text-xs`}>{r.referenceNumber || '—'}</td>
              <td className={`${td} text-gray-600 max-w-[240px] truncate`} title={r.description || ''}>{r.description || '—'}</td>
              <td className={`${tdRight} ${r.direction === 'in' ? 'text-finance-green' : r.direction === 'out' ? 'text-finance-red' : 'text-gray-600'}`}>{formatCurrency(r.amount)}</td>
              <td className={tdRight}>{formatCurrency(r.fee)}</td>
              <td className={tdRight}>{formatCurrency(r.charges)}</td>
              <td className={`${tdRight} ${r.feeCharges > 0 ? 'font-semibold' : 'text-gray-400'}`}>{formatCurrency(r.feeCharges)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-gray-100 border-t border-gray-200">
          <tr>
            <td className={`${td} font-semibold`} colSpan={6}>Fees earned — completed ({summary.cashCompletedCount})</td>
            <td className={`${tdRight} text-gray-400`}>—</td>
            <td className={tdRight}>{formatCurrency(summary.earnedFee)}</td>
            <td className={tdRight}>{formatCurrency(summary.earnedCharges)}</td>
            <td className={`${tdRight} font-semibold text-finance-green`}>{formatCurrency(summary.earned)}</td>
          </tr>
          <tr>
            <td className={`${td} font-semibold`} colSpan={6}>Fees refunded — reversed ({summary.cashReversedCount})</td>
            <td className={`${tdRight} text-gray-400`}>—</td>
            <td className={tdRight}>{formatCurrency(summary.refundedFee)}</td>
            <td className={tdRight}>{formatCurrency(summary.refundedCharges)}</td>
            <td className={`${tdRight} font-semibold text-amber-600`}>{formatCurrency(summary.refunded)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    <div className="mt-2 space-y-1 text-xs">
      <Reconciles label="Txn Fees + Charges" expected={parent.txnFees + parent.additionalCharges} actual={summary.earned} />
      {(parent.reversedExcluded > 0 || summary.refunded > 0) && (
        <Reconciles label="Reversed (Excluded)" expected={parent.reversedExcluded} actual={summary.refunded} />
      )}
    </div>
  </>
);

const LoadingTable = ({ rows, summary, parent }: { rows: LoadingRow[]; summary: Detail['summary']; parent: IncomeParentRow }) => (
  <>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px]">
        <thead className="bg-gray-100">
          <tr>
            <th className={th}>Txn #</th>
            <th className={th}>Date</th>
            <th className={th}>Product</th>
            <th className={th}>Customer</th>
            <th className={thRight}>Qty</th>
            <th className={thRight}>Revenue</th>
            <th className={thRight}>Cost</th>
            <th className={thRight}>Margin</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className={`${td} font-medium`}>{numberLabel(r.transactionNumber)}</td>
              <td className={td}>{dateLabel(r.createdAt)}</td>
              <td className={td}>{r.productName || '—'}</td>
              <td className={td}>{r.customerNumber || '—'}</td>
              <td className={tdRight}>{r.quantity}</td>
              <td className={tdRight}>{formatCurrency(r.revenue)}</td>
              <td className={tdRight}>{formatCurrency(r.cost)}</td>
              <td className={`${tdRight} ${r.margin >= 0 ? 'text-finance-green' : 'text-finance-red'}`}>{formatCurrency(r.margin)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-gray-100 border-t border-gray-200">
          <tr>
            <td className={`${td} font-semibold`} colSpan={4}>Total ({summary.loadingCount} loadings)</td>
            <td className={tdRight}>{rows.reduce((sum, r) => sum + r.quantity, 0)}</td>
            <td className={tdRight}>{formatCurrency(summary.loadRevenue)}</td>
            <td className={tdRight}>{formatCurrency(summary.loadCost)}</td>
            <td className={`${tdRight} font-semibold ${summary.loadMargin >= 0 ? 'text-finance-green' : 'text-finance-red'}`}>{formatCurrency(summary.loadMargin)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    <div className="mt-2 text-xs">
      <Reconciles label="Loading Margin" expected={parent.loadMargin} actual={summary.loadMargin} />
    </div>
  </>
);

const TransfersTable = ({ rows, summary, parent }: { rows: TransferRow[]; summary: Detail['summary']; parent: IncomeParentRow }) => (
  <>
    <p className="text-xs text-gray-500 mb-2">
      Funded from this account — the side the transfer fee was charged to.
    </p>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[750px]">
        <thead className="bg-gray-100">
          <tr>
            <th className={th}>Reference</th>
            <th className={th}>Date</th>
            <th className={th}>Destination</th>
            <th className={thRight}>Amount</th>
            <th className={thRight}>Fee</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className={`${td} font-mono text-xs font-medium`}>{r.transferReference || (r.transferNumber === null ? '—' : `TRF #${r.transferNumber}`)}</td>
              <td className={td}>{dateLabel(r.transferDate)}</td>
              <td className={td}>{r.destinationName || '—'}</td>
              <td className={tdRight}>{formatCurrency(r.amount)}</td>
              <td className={`${tdRight} ${r.fee > 0 ? 'font-semibold' : 'text-gray-400'}`}>{formatCurrency(r.fee)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-gray-100 border-t border-gray-200">
          <tr>
            <td className={`${td} font-semibold`} colSpan={3}>Total ({summary.transferCount} transfers)</td>
            <td className={tdRight}>{formatCurrency(summary.transferAmount)}</td>
            <td className={`${tdRight} font-semibold text-finance-green`}>{formatCurrency(summary.transferFees)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    <div className="mt-2 text-xs">
      <Reconciles label="Transfer Fees" expected={parent.transferFees} actual={summary.transferFees} />
    </div>
  </>
);

export function IncomeDetailPanel({ detail, tab, onTab, parent }: Props) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 print:hidden">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onTab(t.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${active ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
              {t.label}
              <span className="ml-1.5 text-xs text-gray-400">{countFor(detail, t.id)}</span>
            </button>
          );
        })}
      </div>

      {/* A printed statement has no tabs to switch, so all three tables are kept
          in the DOM and only the chosen one is shown on screen. */}
      <div className="pt-3">
        <div className={tab === 'cash' ? '' : 'hidden print:block'}>
          <h5 className="hidden print:block font-semibold text-sm text-gray-800 mb-1">Cash Transactions</h5>
          {detail.cash.length === 0 ? <EmptyTab tab="cash" /> : <CashTable rows={detail.cash} summary={detail.summary} parent={parent} />}
        </div>
        <div className={tab === 'loading' ? '' : 'hidden print:block'}>
          <h5 className="hidden print:block font-semibold text-sm text-gray-800 mb-1 mt-5">Loading</h5>
          {detail.loading.length === 0 ? <EmptyTab tab="loading" /> : <LoadingTable rows={detail.loading} summary={detail.summary} parent={parent} />}
        </div>
        <div className={tab === 'transfers' ? '' : 'hidden print:block'}>
          <h5 className="hidden print:block font-semibold text-sm text-gray-800 mb-1 mt-5">Transfers</h5>
          {detail.transfers.length === 0 ? <EmptyTab tab="transfers" /> : <TransfersTable rows={detail.transfers} summary={detail.summary} parent={parent} />}
        </div>
      </div>
    </div>
  );
}
