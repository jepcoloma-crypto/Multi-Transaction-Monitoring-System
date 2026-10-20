import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import {
  formatCurrency,
  manilaDateTimeLabel,
  transactionTypeLabel,
} from '../lib/format';
import { AlertTriangle, CheckCircle2, RefreshCw, RotateCcw, Search, X } from 'lucide-react';

const money = (value: unknown): string => {
  const n = Number(value);
  return formatCurrency(Number.isFinite(n) ? n : 0);
};

// The four words an operator knows the toggle by. The mode decides what posts
// in two of the four cells (D42), so every row here is judged against both
// readings of it — the server computes both from the same arithmetic the
// entry route writes with, and this page only renders the answer.
const modeLabel = (on: boolean) => (on ? 'ON — added to balance' : 'OFF — inside the amount');
const modeShort = (on: boolean) => (on ? 'ON' : 'OFF');

type FeeStatus = 'ok' | 'opposite' | 'neither';

interface Leg {
  accountTotal: number;
  drawerNet: number | null;
}

interface FeeColumns {
  amount: number;
  fee: number;
  net_amount: number;
  fee_added_to_balance: boolean;
}

interface AuditRow extends FeeColumns {
  id: string;
  transaction_number: string | null;
  transaction_date: string;
  reference_number: string | null;
  description: string | null;
  payment_method: string;
  direction: string;
  type_code: string | null;
  type_name: string | null;
  account_id: string;
  account_name: string;
  drawer_account_id: string | null;
  drawer_account_name: string | null;
  status: FeeStatus;
  actual: Leg;
  declared: Leg;
  opposite: Leg;
}

interface PreviewData {
  before: FeeColumns;
  target: FeeColumns;
  changed: Partial<FeeColumns> | null;
  posted: Leg;
  targetPosted: Leg;
  drawerAccountId: string | null;
  simulation: {
    corrections: { accountId: string; entryType: string; amount: number }[];
    balances: { accountId: string; before: number; after: number }[];
    problems: string[];
    affectedAccountsAfter: { id: string; name: string; reconciled: boolean; gap: number }[];
  };
  /**
   * The fee's own line moving to the side the declared mode names — a cash-in's
   * two tender modes book identical pesos, so these rows are all a re-post with
   * a changed mode has to show for it.
   */
  recarve: { accountId: string; entryType: string; amount: number; role: string }[] | null;
  nothingToDo: boolean;
  safeToApply: boolean;
  closedAccounts: string[];
}

const STATUS_META: Record<FeeStatus, { label: string; badge: string; panel: string; hint: string }> = {
  ok: {
    label: 'Posted as declared',
    badge: 'bg-green-100 text-green-800',
    panel: 'bg-green-50 border-green-200 text-green-800',
    hint: 'The rows sum to exactly what the declared fee mode posts. Nothing is off by a centavo as far as the ledger can tell.',
  },
  opposite: {
    label: 'Opposite mode',
    badge: 'bg-amber-100 text-amber-800',
    panel: 'bg-amber-50 border-amber-200 text-amber-900',
    hint:
      'The rows sum to what the OTHER fee mode posts — either the toggle was backwards when this was entered, or the movement predates the fee riding the account (D42). The figures alone cannot say which: the till count the movement really produced decides it.',
  },
  neither: {
    label: 'Matches neither',
    badge: 'bg-red-100 text-red-800',
    panel: 'bg-red-50 border-red-200 text-red-900',
    hint:
      'Neither fee mode produces these figures — the amount or the fee itself was most likely mistyped. Correct both here if the tender was also wrong.',
  },
};

// A record column as it reads in the diff: money figures as money, the flag
// as the words the form uses for it.
const colLabel = (key: string) =>
  key === 'fee_added_to_balance'
    ? 'Fee mode'
    : key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const colValue = (key: string, value: unknown): string =>
  key === 'fee_added_to_balance' ? modeLabel(Boolean(value)) : money(value);

export default function FeeAudit() {
  const { user } = useAuth();
  const isAdmin = user?.roles?.includes('administrator') ?? false;

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [direction, setDirection] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');

  const [selected, setSelected] = useState<AuditRow | null>(null);
  const [mode, setMode] = useState(true);
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('');
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [stale, setStale] = useState(false);
  const [reason, setReason] = useState('');
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (direction) params.set('direction', direction);
      const data = await api.get<AuditRow[]>(`/corrections/fee-audit?${params}`);
      setRows(data ?? []);
    } catch (err) {
      console.error('Fee audit load error:', err);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [direction]);

  useEffect(() => {
    load();
  }, [load]);

  const runPreview = useCallback(
    async (row: AuditRow, next: { amount: string; fee: string; mode: boolean }) => {
      setPreviewing(true);
      setPreviewError(null);
      try {
        const data = await api.post<PreviewData>('/corrections/fee-repost/preview', {
          sourceId: row.id,
          target: {
            feeAddedToBalance: next.mode,
            amount: parseFloat(next.amount),
            fee: parseFloat(next.fee),
          },
        });
        setPreview(data);
        setStale(false);
        return data;
      } catch (err: any) {
        setPreviewError(err.message || 'Preview failed');
        setPreview(null);
        return null;
      } finally {
        setPreviewing(false);
      }
    },
    []
  );

  // The preview follows the form the same way Amount Corrections' does: any
  // edit re-runs it after a short pause, and apply stays locked until the
  // preview on screen matches what the form now says. A figure the server
  // could not read is simply not previewed — stale stays set, so nothing
  // unreviewed can be committed.
  useEffect(() => {
    if (!selected) return;
    const a = parseFloat(amount);
    const f = parseFloat(fee);
    if (!(Number.isFinite(a) && a >= 0 && Number.isFinite(f) && f >= 0)) return;
    const timer = setTimeout(() => {
      runPreview(selected, { amount, fee, mode });
    }, 350);
    return () => clearTimeout(timer);
  }, [selected, amount, fee, mode, runPreview]);

  const openRecord = (row: AuditRow) => {
    setSelected(row);
    setMode(row.fee_added_to_balance);
    setAmount(String(row.amount));
    setFee(String(row.fee));
    setReason('');
    setApplied(null);
    setPreview(null);
    setPreviewError(null);
    setStale(true);
  };

  const closeDialog = () => {
    setSelected(null);
    setPreview(null);
    setApplied(null);
    setPreviewError(null);
  };

  const handleApply = async () => {
    if (!selected || !preview?.safeToApply) return;
    if (!reason.trim()) {
      setPreviewError('A reason is required before a re-post can be applied.');
      return;
    }
    setApplying(true);
    try {
      const res = await api.post<{ applied: unknown[]; changed: Record<string, unknown> | null }>(
        `/corrections/fee-repost/${selected.id}/apply`,
        {
          reason: reason.trim(),
          target: { feeAddedToBalance: mode, amount: parseFloat(amount), fee: parseFloat(fee) },
        }
      );
      const rowsWritten = res.applied?.length ?? 0;
      setApplied(
        res.changed
          ? `Re-posted. ${rowsWritten} ledger row(s) appended and the record updated.`
          : `Re-posted. ${rowsWritten} ledger row(s) appended.`
      );
      setReason('');
      load();
    } catch (err: any) {
      setPreviewError(err.message || 'Re-post failed');
    } finally {
      setApplying(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="p-6">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5" />
          <div>
            <p className="font-medium text-amber-900">Administrator access required</p>
            <p className="text-sm text-amber-800">
              Re-posting a fee moves money between an account and the till, so it is limited to
              administrators.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const attention = rows.filter((r) => r.status !== 'ok').length;

  const filtered = rows.filter((r) => {
    if (statusFilter === 'attention' && r.status === 'ok') return false;
    if (statusFilter === 'ok' && r.status !== 'ok') return false;
    if (!search.trim()) return true;
    const haystack = [r.transaction_number, r.reference_number, r.description, r.account_name, r.type_name, r.type_code]
      .filter((v): v is string => typeof v === 'string')
      .join(' ')
      .toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });

  const impact = (preview?.simulation.balances ?? []).map((b) => {
    const account = preview!.simulation.affectedAccountsAfter.find((a) => a.id === b.accountId);
    return { ...b, name: account?.name ?? b.accountId, reconciled: account?.reconciled, gap: account?.gap };
  });

  const canApply = Boolean(
    preview?.safeToApply && !stale && !previewing && !applying && !applied && reason.trim()
  );

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Fee Audit — ON / OFF</h1>
        <p className="text-sm text-gray-600 mt-1">
          Every completed movement with a fee, checked against both fee modes: what the rows actually
          posted, what the declared ON/OFF mode says should have posted, and what the other mode
          would. Re-post a row to fix a backwards toggle or a mistyped figure — the fix appends delta
          rows on the account and the till with a reason and an audit entry, exactly as Amount
          Corrections appends. Nothing already posted is rewritten.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          {rows.length} fee-bearing movement(s) loaded · <span className="font-medium text-amber-700">{attention} need attention</span> ·
          latest 200 by date when no direction is filtered.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
        >
          <option value="">All directions</option>
          <option value="in">Cash in</option>
          <option value="out">Cash out</option>
          <option value="adjustment">Adjustment</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
        >
          <option value="">All statuses</option>
          <option value="attention">Needs attention</option>
          <option value="ok">Posted as declared</option>
        </select>
        <div className="relative ml-auto">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search this page"
            className="pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm w-56"
          />
        </div>
        <button
          onClick={load}
          className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100"
          title="Reload"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="bg-white rounded-lg border overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3">Record</th>
              <th className="px-4 py-3">Reference</th>
              <th className="px-4 py-3 text-right">Amount / Fee</th>
              <th className="px-4 py-3 text-center">Mode</th>
              <th className="px-4 py-3">Posted (account · till)</th>
              <th className="px-4 py-3">Declared says</th>
              <th className="px-4 py-3 text-center">Status</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                  {loading ? 'Loading…' : 'No completed fee-bearing movements match this filter.'}
                </td>
              </tr>
            )}
            {filtered.map((row) => (
              <tr key={row.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-900">{row.transaction_number ?? 'Movement'}</p>
                  <p className="text-xs text-gray-500">
                    {manilaDateTimeLabel(row.transaction_date)} ·{' '}
                    {transactionTypeLabel(row.type_code, row.type_name)} · {row.account_name}
                  </p>
                </td>
                <td className="px-4 py-3 text-gray-700 whitespace-nowrap font-mono text-xs">
                  {row.reference_number || '-'}
                </td>
                <td className="px-4 py-3 text-right">
                  <p className="font-medium tabular-nums">{money(row.amount)}</p>
                  <p className="text-xs text-gray-500 tabular-nums">fee {money(row.fee)}</p>
                </td>
                <td className="px-4 py-3 text-center">
                  <span
                    title={modeLabel(row.fee_added_to_balance)}
                    className={`px-2 py-1 rounded-full text-xs font-medium ${
                      row.fee_added_to_balance ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {modeShort(row.fee_added_to_balance)}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs tabular-nums">
                  <p className="font-medium text-gray-900">{money(row.actual.accountTotal)}</p>
                  {row.actual.drawerNet !== null && (
                    <p className="text-gray-500">till {money(row.actual.drawerNet)}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-xs tabular-nums">
                  <p className="font-medium text-gray-900">{money(row.declared.accountTotal)}</p>
                  {row.declared.drawerNet !== null && (
                    <p className="text-gray-500">till {money(row.declared.drawerNet)}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-center">
                  <span
                    title={STATUS_META[row.status].hint}
                    className={`px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ${STATUS_META[row.status].badge}`}
                  >
                    {STATUS_META[row.status].label}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => openRecord(row)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-600 text-white hover:bg-primary-700"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Re-post
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center overflow-y-auto p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-8">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <div>
                <h2 className="font-semibold text-gray-900">Re-post this movement</h2>
                <p className="text-xs text-gray-500">
                  {selected.transaction_number ?? 'Movement'} · {selected.account_name} ·{' '}
                  {transactionTypeLabel(selected.type_code, selected.type_name)}
                </p>
              </div>
              <button onClick={closeDialog} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-4 space-y-5 max-h-[65vh] overflow-y-auto">
              {applied && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-start gap-2">
                  <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5" />
                  <p className="text-sm text-green-800">{applied}</p>
                </div>
              )}

              <section>
                <h3 className="text-xs font-semibold uppercase text-gray-500 mb-2">As recorded</h3>
                <div className={`rounded-lg border p-3 mb-3 text-sm ${STATUS_META[selected.status].panel}`}>
                  <p className="font-medium">{STATUS_META[selected.status].label}</p>
                  <p className="text-xs mt-0.5 text-gray-700">{STATUS_META[selected.status].hint}</p>
                </div>
                <div className="space-y-1 text-sm">
                  {[
                    { label: 'Posted by the rows', leg: selected.actual },
                    {
                      label: `Declared mode ${modeShort(selected.fee_added_to_balance)} says`,
                      leg: selected.declared,
                    },
                    {
                      label: `Other mode ${modeShort(!selected.fee_added_to_balance)} says`,
                      leg: selected.opposite,
                    },
                  ].map((line) => (
                    <div key={line.label} className="flex justify-between bg-gray-50 rounded px-3 py-2">
                      <span className="text-gray-600">{line.label}</span>
                      <span className="tabular-nums">
                        {money(line.leg.accountTotal)}
                        {line.leg.drawerNet !== null && (
                          <span className="text-gray-500"> · till {money(line.leg.drawerNet)}</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
                {selected.drawer_account_name && (
                  <p className="text-xs text-gray-400 mt-1">Till: {selected.drawer_account_name}</p>
                )}
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase text-gray-500 mb-2">Re-post to</h3>
                <div className="flex rounded-lg bg-gray-100 p-1 w-fit mb-3">
                  {[true, false].map((m) => (
                    <button
                      key={String(m)}
                      onClick={() => {
                        setMode(m);
                        setStale(true);
                        setApplied(null);
                      }}
                      className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                        mode === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                      }`}
                    >
                      {modeLabel(m)}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs text-gray-600">Amount</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => {
                        setAmount(e.target.value);
                        setStale(true);
                        setApplied(null);
                      }}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-gray-600">Fee</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={fee}
                      onChange={(e) => {
                        setFee(e.target.value);
                        setStale(true);
                        setApplied(null);
                      }}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    />
                  </label>
                </div>

                {preview?.changed && Object.keys(preview.changed).length > 0 && (
                  <div className="mt-3">
                    <h4 className="text-xs font-semibold uppercase text-gray-500 mb-2">Record columns</h4>
                    <dl className="space-y-1">
                      {Object.entries(preview.changed).map(([key, value]) => (
                        <div
                          key={key}
                          className="flex items-start gap-3 text-sm bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
                        >
                          <dt className="text-gray-600 w-44 shrink-0">{colLabel(key)}</dt>
                          <dd className="text-gray-900">
                            <span className="text-gray-500 line-through">
                              {colValue(key, (preview.before as unknown as Record<string, unknown>)[key])}
                            </span>
                            <span className="mx-2 text-gray-400">→</span>
                            <span>{colValue(key, value)}</span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase text-gray-500 mb-2">Ledger impact</h3>
                {previewError && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-2">
                    {previewError}
                  </p>
                )}
                {preview?.simulation.problems.map((p, i) => (
                  <p key={i} className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-2">
                    {p}
                  </p>
                ))}
                {(preview?.closedAccounts.length ?? 0) > 0 && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-2">
                    Closed: {preview!.closedAccounts.join(', ')} — closed accounts do not move.
                  </p>
                )}
                {preview?.nothingToDo && !previewError && (
                  <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2">
                    These figures post exactly what is already posted — there is nothing to re-post.
                  </p>
                )}
                {preview ? (
                  <div className="space-y-2">
                    <div className="bg-gray-50 rounded-lg px-3 py-2 text-sm">
                      <p className="text-xs text-gray-500 mb-1">Account and till, as posted → after</p>
                      <p className="tabular-nums">
                        {money(preview.posted.accountTotal)} → {money(preview.targetPosted.accountTotal)}
                        {preview.posted.drawerNet !== null && preview.targetPosted.drawerNet !== null && (
                          <span className="text-gray-500">
                            {' '}
                            · till {money(preview.posted.drawerNet)} → {money(preview.targetPosted.drawerNet)}
                          </span>
                        )}
                      </p>
                    </div>
                    {impact.length === 0 ? (
                      <p className="text-sm text-gray-500">
                        No ledger rows to append — the change lands only on the record's own columns.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {impact.map((i) => (
                          <div
                            key={i.accountId}
                            className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm"
                          >
                            <div>
                              <p className="font-medium text-gray-900">{i.name}</p>
                              <p className="text-xs text-gray-500 tabular-nums">
                                {money(i.before)} → {money(i.after)}
                              </p>
                            </div>
                            <span
                              className={`px-2 py-1 rounded-full text-xs font-medium ${
                                i.reconciled ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                              }`}
                            >
                              {i.reconciled ? 'reconciles' : `gap ${money(i.gap ?? 0)}`}
                            </span>
                          </div>
                        ))}
                        <p className="text-xs text-gray-500">
                          {(preview.simulation.corrections.length + (preview.recarve?.length ?? 0))} ledger
                          row(s) will be appended{preview.recarve?.length ? ', of which these move the fee onto the side you declared' : ''}. Nothing
                          already posted is altered.
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">
                    {previewing ? 'Previewing…' : 'Reading what this re-post would append…'}
                  </p>
                )}
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase text-gray-500 mb-2">Reason</h3>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="Why is this movement being re-posted? Recorded in the audit trail."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </section>
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t bg-gray-50 rounded-b-xl">
              <button
                onClick={closeDialog}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-100"
              >
                {applied ? 'Close' : 'Cancel'}
              </button>
              {!applied && (
                <button
                  onClick={handleApply}
                  disabled={!canApply}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {applying ? 'Applying…' : 'Apply re-post'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
