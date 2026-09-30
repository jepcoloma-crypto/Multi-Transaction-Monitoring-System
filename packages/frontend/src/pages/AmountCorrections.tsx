import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { formatCurrency } from '../lib/format';
import Pagination from '../components/Pagination';
import { AlertTriangle, CheckCircle2, Pencil, RefreshCw, Search, X } from 'lucide-react';

type SourceType = 'transaction' | 'transfer' | 'loading';

interface AmountField {
  key: string;
  label: string;
  kind: 'money' | 'qty';
  min: number | null;
}

interface AuditAccount {
  id: string;
  name: string;
  currentBalance: number;
  gap: number;
  reconciled: boolean;
  entryCount: number;
  chainBreaks: number;
}

interface CorrectionRow {
  accountId: string;
  entryType: 'credit' | 'debit';
  amount: number;
  balanceAfter: number;
}

interface PreviewData {
  shape: { ok: boolean; problems: string[] };
  simulation: {
    corrections: CorrectionRow[];
    balances: { accountId: string; before: number; after: number }[];
    affectedAccountsAfter: AuditAccount[];
    problems: string[];
  } | null;
  safeToCorrect: boolean;
  record: Record<string, unknown> | null;
  columns: Record<string, number> | null;
  recordChanged: boolean;
  amountFields: AmountField[];
}

interface ListedRow {
  id: string;
  status?: string;
  [key: string]: unknown;
}

const TABS: { key: SourceType; label: string; endpoint: string; supportsStatus: boolean }[] = [
  { key: 'transaction', label: 'Cash Transactions', endpoint: '/transactions', supportsStatus: true },
  { key: 'transfer', label: 'Fund Transfers', endpoint: '/transfers', supportsStatus: true },
  { key: 'loading', label: 'Loading', endpoint: '/loading', supportsStatus: false },
];

const money = (value: unknown): string => {
  const n = Number(value);
  return formatCurrency(Number.isFinite(n) ? n : 0);
};

const describe = (type: SourceType, row: ListedRow) => {
  if (type === 'transaction') {
    const bits = [`#${row.transaction_number ?? ''}`];
    if (row.description) bits.push(String(row.description));
    return {
      title: bits.join(' · '),
      subtitle: [row.account_name, row.type_name].filter(Boolean).join(' · '),
      amount: row.amount,
    };
  }
  if (type === 'transfer') {
    return {
      title: String(row.transfer_reference ?? ''),
      subtitle: [row.source_name, row.destination_name].filter(Boolean).join(' → '),
      amount: row.transfer_amount,
    };
  }
  const bits = [row.product_name ?? 'Loading'];
  if (row.customer_number) bits.push(String(row.customer_number));
  return {
    title: bits.join(' · '),
    subtitle: [row.account_name, row.quantity ? `${row.quantity} unit(s)` : null].filter(Boolean).join(' · '),
    amount: row.total_revenue,
  };
};

export default function AmountCorrections() {
  const { user } = useAuth();
  const isAdmin = user?.roles?.includes('administrator') ?? false;

  const [tab, setTab] = useState<SourceType>('transaction');
  const [rows, setRows] = useState<ListedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [search, setSearch] = useState('');

  const [selected, setSelected] = useState<ListedRow | null>(null);
  const [fieldSpecs, setFieldSpecs] = useState<AmountField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<string[]>([]);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [stale, setStale] = useState(false);
  const [reason, setReason] = useState('');
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);

  const load = useCallback(
    async (page = 1) => {
      setLoading(true);
      try {
        const cfg = TABS.find((t) => t.key === tab)!;
        const params = new URLSearchParams({ page: String(page), limit: '20' });
        if (cfg.supportsStatus) params.set('status', 'completed');
        const res = await api.get<{ data: ListedRow[]; pagination?: { page: number; totalPages: number; total: number } }>(
          `${cfg.endpoint}?${params}`
        );
        const fetched = res.data ?? [];
        const completed = cfg.supportsStatus ? fetched : fetched.filter((r) => String(r.status) === 'completed');
        setRows(completed);
        setPagination(res.pagination ?? { page: 1, totalPages: 1, total: completed.length });
      } catch (err) {
        console.error('Amount corrections load error:', err);
        setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [tab]
  );

  useEffect(() => {
    load(1);
  }, [load]);

  const runPreview = useCallback(
    async (type: SourceType, id: string, fieldValues: Record<string, number>) => {
      setPreviewing(true);
      setPreviewError(null);
      try {
        const data = await api.post<PreviewData>('/corrections/preview', {
          sourceType: type,
          sourceId: id,
          fields: fieldValues,
        });
        setPreview(data);
        setStale(false);
        return data;
      } catch (err: any) {
        setPreviewError(err.message || 'Preview failed');
        setPreview(null);
        setStale(false);
        return null;
      } finally {
        setPreviewing(false);
      }
    },
    []
  );

  const buildPayload = useCallback(() => {
    const out: Record<string, number> = {};
    for (const key of touched) out[key] = parseFloat(values[key] ?? '');
    return out;
  }, [touched, values]);

  const openRecord = async (row: ListedRow) => {
    setSelected(row);
    setReason('');
    setApplied(null);
    setPreview(null);
    setPreviewError(null);
    setTouched([]);
    setValues({});
    setFieldSpecs([]);
    const data = await runPreview(tab, row.id, {});
    if (data?.amountFields) {
      setFieldSpecs(data.amountFields);
      const initial: Record<string, string> = {};
      for (const field of data.amountFields) {
        const raw = data.record?.[field.key];
        initial[field.key] = raw === null || raw === undefined ? '' : String(raw);
      }
      setValues(initial);
    }
  };

  useEffect(() => {
    if (!selected || touched.length === 0) return;
    const timer = setTimeout(() => {
      runPreview(tab, selected.id, buildPayload());
    }, 350);
    return () => clearTimeout(timer);
  }, [values, touched, selected, tab, runPreview, buildPayload]);

  const closeDialog = () => {
    setSelected(null);
    setPreview(null);
    setFieldSpecs([]);
    setApplied(null);
  };

  const handleApply = async () => {
    if (!selected || !preview?.safeToCorrect) return;
    if (!reason.trim()) {
      setPreviewError('A reason is required before a correction can be applied.');
      return;
    }
    setApplying(true);
    try {
      const res = await api.post<{ applied: CorrectionRow[]; changed: Record<string, number> | null }>(
        `/corrections/${tab}/${selected.id}/apply`,
        { fields: buildPayload(), reason: reason.trim() }
      );
      const rowsWritten = res.applied?.length ?? 0;
      setApplied(
        res.changed
          ? `Saved. ${rowsWritten} ledger row(s) appended and the record updated.`
          : `Saved. ${rowsWritten} ledger row(s) appended.`
      );
      setTouched([]);
      setReason('');
      load(pagination.page);
    } catch (err: any) {
      setPreviewError(err.message || 'Correction failed');
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
              Correcting an amount moves money, so it is limited to administrators.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const filtered = rows.filter((r) => {
    if (!search.trim()) return true;
    const haystack = Object.values(r)
      .filter((v) => typeof v === 'string' || typeof v === 'number')
      .join(' ')
      .toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });

  const derived = (preview?.columns
    ? Object.entries(preview.columns).filter(([key]) => !fieldSpecs.some((f) => f.key === key))
    : []) as [string, number][];

  const impact = (preview?.simulation?.balances ?? []).map((b) => {
    const account = preview!.simulation!.affectedAccountsAfter.find((a) => a.id === b.accountId);
    return { ...b, name: account?.name ?? b.accountId, reconciled: account?.reconciled, gap: account?.gap };
  });

  const canApply = Boolean(preview?.safeToCorrect && !stale && !previewing && !applying && !applied);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Amount Corrections</h1>
        <p className="text-sm text-gray-600 mt-1">
          Correct the amount on a completed cash transaction, fund transfer or loading entry. The ledger is
          reconciled in the same step, so reports keep matching the record. Completed records are never
          rewritten — each correction is appended and audited.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.key ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
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
          onClick={() => load(pagination.page)}
          className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100"
          title="Reload"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="bg-white rounded-lg border overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3">Record</th>
              <th className="px-4 py-3">Account / Parties</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 text-center">Status</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                  {loading ? 'Loading…' : 'No completed records of this type.'}
                </td>
              </tr>
            )}
            {filtered.map((row) => {
              const d = describe(tab, row);
              return (
                <tr key={row.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{d.title}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{d.subtitle}</td>
                  <td className="px-4 py-3 text-right font-medium">{money(d.amount)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className="px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                      {String(row.status ?? 'completed')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => openRecord(row)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-600 text-white hover:bg-primary-700"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      Correct amount
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="px-4">
          <Pagination
            page={pagination.page}
            totalPages={pagination.totalPages}
            total={pagination.total}
            onPageChange={load}
          />
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center overflow-y-auto p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-8">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <div>
                <h2 className="font-semibold text-gray-900">Correct amount</h2>
                <p className="text-xs text-gray-500">
                  {describe(tab, selected).title} · {describe(tab, selected).subtitle}
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
                <h3 className="text-xs font-semibold uppercase text-gray-500 mb-2">Figures</h3>
                <div className="grid grid-cols-2 gap-3">
                  {fieldSpecs.map((field) => (
                    <label key={field.key} className="block">
                      <span className="text-xs text-gray-600">{field.label}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={values[field.key] ?? ''}
                        onChange={(e) => {
                          const next = e.target.value;
                          setValues((v) => ({ ...v, [field.key]: next }));
                          setTouched((t) => (t.includes(field.key) ? t : [...t, field.key]));
                          setStale(true);
                          setApplied(null);
                        }}
                        className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                      />
                    </label>
                  ))}
                </div>
              </section>

              {derived.length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold uppercase text-gray-500 mb-2">Recomputed</h3>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    {derived.map(([key, value]) => (
                      <div key={key} className="flex justify-between bg-gray-50 rounded px-3 py-2">
                        <dt className="text-gray-600">{key.replace(/_/g, ' ')}</dt>
                        <dd className="font-medium">{money(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}

              <section>
                <h3 className="text-xs font-semibold uppercase text-gray-500 mb-2">Ledger impact</h3>
                {previewError && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-2">
                    {previewError}
                  </p>
                )}
                {preview?.simulation?.problems?.map((p, i) => (
                  <p key={i} className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-2">
                    {p}
                  </p>
                ))}
                {impact.length === 0 ? (
                  <p className="text-sm text-gray-500">
                    {previewing ? 'Previewing…' : 'No ledger movement — these figures do not change what was posted.'}
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
                          <p className="text-xs text-gray-500">
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
                      {preview?.simulation?.corrections.length ?? 0} ledger row(s) will be appended. Nothing already
                      posted is altered.
                    </p>
                  </div>
                )}
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase text-gray-500 mb-2">Reason</h3>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="Why is this figure being corrected? Recorded in the audit trail."
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
                  {applying ? 'Applying…' : 'Apply correction'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
