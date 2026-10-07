import { useState } from 'react';
import { api } from '../lib/api';
import { formatCurrency, manilaDayLabel } from '../lib/format';
import { Check, AlertTriangle, ChevronRight, X } from 'lucide-react';

// The Sources & Uses statement, moved here from Cash Management unchanged
// (D18, R3). A period belongs to Reports, and `buildCashStatement` behind these
// figures is the same code it has always been — this panel reads the endpoint
// that computes it rather than restating any of the arithmetic.

interface BucketLine {
  bucket: string;
  label: string;
  amount: number;
  count: number;
}

interface BranchStatement {
  branchId: string;
  code: string;
  name: string;
  opening: number;
  sources: number;
  uses: number;
  closing: number;
  current: number;
}

export interface CashStatement {
  period: { startDate: string | null; endDate: string | null };
  sources: BucketLine[];
  uses: BucketLine[];
  branches: BranchStatement[];
  totals: {
    opening: number; sources: number; uses: number;
    closing: number; current: number; difference: number; balanced: boolean;
  };
}

interface DrillRow {
  id: string;
  entry_date: string;
  entry_type: string;
  amount: number;
  balance_after: number | string;
  source_type: string | null;
  reference_number: string | null;
  description: string | null;
  account_name: string;
  branch_code: string;
  transaction_number: number | null;
  payee: string | null;
}

interface Drill {
  bucket: string;
  label: string;
  direction: string;
  total: number;
  truncated: boolean;
  rows: DrillRow[];
}

export function CashStatementPanel({ statement, branchId }: { statement: CashStatement; branchId: string }) {
  const [drill, setDrill] = useState<Drill | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const t = statement.totals;

  const openDrill = async (line: BucketLine, direction: 'credit' | 'debit') => {
    setDrillLoading(true);
    try {
      const params = new URLSearchParams({ bucket: line.bucket, direction });
      if (branchId) params.set('branchId', branchId);
      setDrill(await api.get<Drill>(`/cash-management/statement/drill?${params.toString()}`));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not load the rows behind this figure');
    } finally {
      setDrillLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* The invariant the whole statement exists to satisfy, stated before the
          figures that make it up: if this is wrong, every number below is
          wrong with it. */}
      <div className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${
        t.balanced ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'
      }`}>
        {t.balanced ? <Check className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
        <span>
          {t.balanced
            ? 'Opening plus sources minus uses ties to the balances exactly.'
            : `Off by ${formatCurrency(t.difference)} — opening ${formatCurrency(t.opening)} plus sources minus uses does not yet reach the closing position.`}
        </span>
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 pt-4 pb-1">
          <h4 className="font-medium">Position by branch</h4>
          <p className="text-xs text-gray-500">
            Opening plus sources minus uses must equal closing on every line, and closing must equal
            the branch's live balance when the period reaches today.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[840px]">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Branch</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Opening</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Sources</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Uses</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Closing</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Live balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {statement.branches.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500">No branches in scope.</td></tr>
              ) : statement.branches.map((b) => {
                const tied = Math.abs(b.closing - b.current) < 0.005;
                return (
                  <tr key={b.branchId} className="hover:bg-gray-50">
                    <td className="px-4 py-3.5 text-sm font-medium whitespace-nowrap">
                      {b.name} <span className="text-gray-400 font-normal">({b.code})</span>
                    </td>
                    <td className="px-4 py-3.5 text-sm text-right font-mono text-gray-600">{formatCurrency(b.opening)}</td>
                    <td className="px-4 py-3.5 text-sm text-right font-mono text-emerald-600">{formatCurrency(b.sources)}</td>
                    <td className="px-4 py-3.5 text-sm text-right font-mono text-red-600">{formatCurrency(b.uses)}</td>
                    <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold">{formatCurrency(b.closing)}</td>
                    <td className="px-4 py-3.5 text-sm text-right font-mono">
                      <span className={tied ? 'text-gray-900' : 'text-amber-600'}>{formatCurrency(b.current)}</span>
                      {!tied && (
                        <span className="ml-1.5 text-xs" title="The period ends before today, so closing and the live balance are different figures by design.">·</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-gray-50 border-t border-gray-200">
              <tr>
                <td className="px-4 py-3.5 text-sm font-semibold whitespace-nowrap">Total</td>
                <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold">{formatCurrency(t.opening)}</td>
                <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold text-emerald-600">{formatCurrency(t.sources)}</td>
                <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold text-red-600">{formatCurrency(t.uses)}</td>
                <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold">{formatCurrency(t.closing)}</td>
                <td className={`px-4 py-3.5 text-sm text-right font-mono font-semibold ${t.balanced ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {formatCurrency(t.current)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card overflow-hidden">
          <div className="px-4 pt-4 pb-1">
            <h4 className="font-medium">Sources</h4>
            <p className="text-xs text-gray-500">Click a line to see the rows behind it.</p>
          </div>
          <table className="w-full mt-2">
            <tbody className="divide-y divide-gray-100">
              {statement.sources.length === 0 ? (
                <tr><td colSpan={2} className="px-4 py-6 text-center text-sm text-gray-500">No inflows recorded.</td></tr>
              ) : statement.sources.map((line) => (
                <tr key={line.bucket} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm">
                    <button
                      type="button"
                      onClick={() => void openDrill(line, 'credit')}
                      className="inline-flex items-center gap-1.5 rounded px-1 -mx-1 py-0.5 text-left hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
                    >
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                      <span>{line.label}</span>
                      <span className="text-xs text-gray-400">{line.count}</span>
                    </button>
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-mono text-emerald-600">{formatCurrency(line.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="px-4 pt-4 pb-1">
            <h4 className="font-medium">Uses</h4>
            <p className="text-xs text-gray-500">Click a line to see the rows behind it.</p>
          </div>
          <table className="w-full mt-2">
            <tbody className="divide-y divide-gray-100">
              {statement.uses.length === 0 ? (
                <tr><td colSpan={2} className="px-4 py-6 text-center text-sm text-gray-500">No outflows recorded.</td></tr>
              ) : statement.uses.map((line) => (
                <tr key={line.bucket} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm">
                    <button
                      type="button"
                      onClick={() => void openDrill(line, 'debit')}
                      className="inline-flex items-center gap-1.5 rounded px-1 -mx-1 py-0.5 text-left hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
                    >
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                      <span>{line.label}</span>
                      <span className="text-xs text-gray-400">{line.count}</span>
                    </button>
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-mono text-red-600">{formatCurrency(line.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {drillLoading && <div className="card text-center py-6 text-sm text-gray-500">Loading rows…</div>}

      {drill && !drillLoading && (
        <div className="card overflow-hidden">
          <div className="px-4 pt-4 pb-1 flex items-start justify-between gap-4">
            <div>
              <h4 className="font-medium">{drill.label} — {drill.rows.length} rows</h4>
              <p className="text-xs text-gray-500">
                {drill.direction === 'credit' ? 'Money in' : 'Money out'} · {formatCurrency(drill.total)}
                {drill.truncated && ' · only the most recent rows in this period are listed'}
              </p>
            </div>
            <button type="button" onClick={() => setDrill(null)} className="text-gray-400 hover:text-gray-600" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Reference</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Account</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Description</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Amount</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Balance after</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {drill.rows.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500">No rows recorded.</td></tr>
                ) : drill.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-3 text-sm whitespace-nowrap">
                      {row.entry_date ? manilaDayLabel(row.entry_date) : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-xs whitespace-nowrap">
                      {row.transaction_number !== null ? `TXN #${row.transaction_number}` : (row.reference_number || '—')}
                    </td>
                    <td className="px-4 py-3 text-sm whitespace-nowrap">
                      {row.account_name} <span className="text-gray-400">· {row.branch_code}</span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 max-w-[320px] truncate" title={row.description || ''}>
                      {row.description || (row.payee ? `Paid to ${row.payee}` : '—')}
                    </td>
                    <td className={`px-4 py-3 text-sm text-right font-mono ${row.entry_type === 'credit' ? 'text-emerald-600' : 'text-red-600'}`}>
                      {row.entry_type === 'credit' ? '+' : '−'}{formatCurrency(Number(row.amount))}
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-mono text-gray-600">
                      {formatCurrency(Number(row.balance_after))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
