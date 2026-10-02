import { formatCurrency } from '../lib/format';
import { Reconciles } from './IncomeDetail';

// The expense side of the Income & Expense Report expands an account into the
// transfers that produced its service fees — the same tree shape the income
// side uses, narrowed to the one table an expense row is funded by.
//
// Every total here is summed from the rows printed below it rather than copied
// down from the account row above. The account row's figures come from an
// aggregate over transfers; these come from the rows fetched for one account.
// Two independently computed figures either agree or visibly do not, which is
// the only way a drill-down can prove the number it explains instead of
// restating it.

export interface ExpenseParentRow {
  transferCount: number;
  serviceFees: number;
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
  rows: TransferRow[];
  summary: {
    transferCount: number;
    transferAmount: number;
    serviceFees: number;
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

const dateLabel = (value: string | null): string =>
  value ? new Date(value).toLocaleDateString() : '—';

const countLabel = (value: number): string => String(value);

export function ExpenseDetailPanel({ detail, parent }: Props) {
  return (
    <>
      <p className="text-xs text-gray-500 mb-2">
        Funded from this account — the side the service charge was deducted from. Rows with no
        charge are listed too, because the account row counts every completed transfer it sent.
      </p>

      {detail.rows.length === 0 ? (
        <p className="text-sm text-gray-500 py-6 text-center">
          No transfers funded from this account in the selected period.
        </p>
      ) : (
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
              {detail.rows.map((r) => (
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
      )}

      <div className="mt-2 space-y-1 text-xs">
        <Reconciles label="Transfers" expected={parent.transferCount} actual={detail.summary.transferCount} format={countLabel} />
        <Reconciles label="Service Fees" expected={parent.serviceFees} actual={detail.summary.serviceFees} />
      </div>
    </>
  );
}
