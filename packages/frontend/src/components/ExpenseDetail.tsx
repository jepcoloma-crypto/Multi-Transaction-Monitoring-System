import { formatCurrency, manilaDayLabel } from '../lib/format';
import { Reconciles } from './IncomeDetail';

// The expense side of the Income & Expense Report expands an account into the
// three things that made its total: the transfers that carried a service fee,
// the provider charges taken from its balance on cash movements, and the
// operating expenses paid out of it.
//
// Every total here is summed from the rows printed below it rather than copied
// down from the account row above. The account row's figures come from
// aggregates over several tables; these come from the rows fetched for one
// account. Two independently computed figures either agree or visibly do not,
// which is the only way a drill-down can prove the number it explains instead
// of restating it.
//
// All three panels are shown even when one is empty, because a total with an
// unexplained part is indistinguishable from a total that is wrong.

export interface ExpenseParentRow {
  transferCount: number;
  serviceFees: number;
  providerCharges: number;
  operatingExpenses: number;
  totalExpense: number;
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

interface ChargeRow {
  id: string;
  transactionNumber: number | null;
  transactionDate: string | null;
  description: string | null;
  amount: number;
  linkedTransactionNumber: number | null;
}

interface OperatingRow {
  id: string;
  transactionNumber: number | null;
  transactionDate: string | null;
  description: string | null;
  payee: string | null;
  amount: number;
}

interface Detail {
  transfers: TransferRow[];
  charges: ChargeRow[];
  operating: OperatingRow[];
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

interface Props {
  detail: Detail;
  parent: ExpenseParentRow;
}

const th = 'px-3 py-2 text-xs font-medium text-gray-500 uppercase whitespace-nowrap';
const thRight = `${th} text-right`;
const td = 'px-3 py-2 text-sm whitespace-nowrap';
const tdRight = `${td} text-right font-mono`;

const dateLabel = (value: string | null): string => manilaDayLabel(value);

const countLabel = (value: number): string => String(value);

function TransferTable({ detail }: { detail: Detail }) {
  if (detail.transfers.length === 0) {
    return (
      <p className="text-sm text-gray-500 py-6 text-center">
        No transfers funded from this account in the selected period.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[750px]">
        <thead className="bg-gray-100">
          <tr>
            <th className={th}>Reference</th>
            <th className={th}>Date</th>
            <th className={th}>Destination</th>
            <th className={thRight}>Amount</th>
            <th className={thRight}>Service Charge</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {detail.transfers.map((r) => (
            <tr key={r.id}>
              <td className={`${td} font-mono text-xs font-medium`}>
                {r.transferReference || (r.transferNumber === null ? '—' : `TRF #${r.transferNumber}`)}
              </td>
              <td className={td}>{dateLabel(r.transferDate)}</td>
              <td className={td}>{r.destinationName || '—'}</td>
              <td className={tdRight}>{formatCurrency(r.amount)}</td>
              <td className={`${tdRight} ${r.fee > 0 ? 'font-semibold text-red-600' : 'text-gray-400'}`}>{formatCurrency(r.fee)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-gray-100 border-t border-gray-200">
          <tr>
            <td className={`${td} font-semibold`} colSpan={3}>Total ({detail.summary.transferCount} transfers)</td>
            <td className={tdRight}>{formatCurrency(detail.summary.transferAmount)}</td>
            <td className={`${tdRight} font-semibold text-red-600`}>{formatCurrency(detail.summary.serviceFees)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ChargeTable({ detail }: { detail: Detail }) {
  if (detail.charges.length === 0) {
    return (
      <p className="text-sm text-gray-500 py-6 text-center">
        No provider charges on this account in the selected period.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[750px]">
        <thead className="bg-gray-100">
          <tr>
            <th className={th}>Txn #</th>
            <th className={th}>Date</th>
            <th className={th}>Provoked by</th>
            <th className={th}>Description</th>
            <th className={thRight}>Charge</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {detail.charges.map((r) => (
            <tr key={r.id}>
              <td className={`${td} font-mono text-xs font-medium`}>
                {r.transactionNumber === null ? '—' : `TXN #${r.transactionNumber}`}
              </td>
              <td className={td}>{dateLabel(r.transactionDate)}</td>
              <td className={`${td} font-mono text-xs`}>
                {r.linkedTransactionNumber === null
                  ? <span className="text-gray-400" title="The originating transaction is no longer recorded — the charge still stands.">—</span>
                  : `TXN #${r.linkedTransactionNumber}`}
              </td>
              <td className={`${td} text-gray-600 max-w-[320px] truncate`} title={r.description || ''}>
                {r.description || '—'}
              </td>
              <td className={`${tdRight} font-semibold text-red-600`}>{formatCurrency(r.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-gray-100 border-t border-gray-200">
          <tr>
            <td className={`${td} font-semibold`} colSpan={4}>Total ({detail.summary.chargeCount} charges)</td>
            <td className={`${tdRight} font-semibold text-red-600`}>{formatCurrency(detail.summary.providerCharges)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function OperatingTable({ detail }: { detail: Detail }) {
  if (detail.operating.length === 0) {
    return (
      <p className="text-sm text-gray-500 py-6 text-center">
        No operating expenses paid from this account in the selected period.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[750px]">
        <thead className="bg-gray-100">
          <tr>
            <th className={th}>Txn #</th>
            <th className={th}>Date</th>
            <th className={th}>Payee</th>
            <th className={th}>Description</th>
            <th className={thRight}>Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {detail.operating.map((r) => (
            <tr key={r.id}>
              <td className={`${td} font-mono text-xs font-medium`}>
                {r.transactionNumber === null ? '—' : `TXN #${r.transactionNumber}`}
              </td>
              <td className={td}>{dateLabel(r.transactionDate)}</td>
              <td className={td}>{r.payee || '—'}</td>
              <td className={`${td} text-gray-600 max-w-[320px] truncate`} title={r.description || ''}>
                {r.description || '—'}
              </td>
              <td className={`${tdRight} font-semibold text-red-600`}>{formatCurrency(r.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-gray-100 border-t border-gray-200">
          <tr>
            <td className={`${td} font-semibold`} colSpan={4}>Total ({detail.summary.operatingCount} expenses)</td>
            <td className={`${tdRight} font-semibold text-red-600`}>{formatCurrency(detail.summary.operatingExpenses)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function ExpenseDetailPanel({ detail, parent }: Props) {
  return (
    <>
      <p className="text-xs text-gray-500 mb-3">
        The rows behind this account's total. Transfer rows with no charge are listed too, because
        the account row counts every completed transfer it sent; provider charges are listed whether
        or not there are transfers, because they are a separate cost the customer never paid for;
        operating expenses are listed because they are money the account actually paid out.
      </p>

      <section className="mb-4">
        <h5 className="text-xs font-semibold uppercase text-gray-500 mb-1.5">Transfers</h5>
        <TransferTable detail={detail} />
      </section>

      <section className="mb-4">
        <h5 className="text-xs font-semibold uppercase text-gray-500 mb-1.5">Provider Charges</h5>
        <ChargeTable detail={detail} />
      </section>

      <section className="mb-2">
        <h5 className="text-xs font-semibold uppercase text-gray-500 mb-1.5">Operating Expenses</h5>
        <OperatingTable detail={detail} />
      </section>

      <div className="space-y-1 text-xs">
        <Reconciles label="Transfers" expected={parent.transferCount} actual={detail.summary.transferCount} format={countLabel} />
        <Reconciles label="Service Fees" expected={parent.serviceFees} actual={detail.summary.serviceFees} />
        <Reconciles label="Provider Charges" expected={parent.providerCharges} actual={detail.summary.providerCharges} />
        <Reconciles label="Operating Expenses" expected={parent.operatingExpenses} actual={detail.summary.operatingExpenses} />
        <Reconciles label="Total Expense" expected={parent.totalExpense} actual={detail.summary.totalExpense} />
      </div>
    </>
  );
}
