import { useState, useEffect, useCallback } from 'react';
import { api, unwrapRows } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { useAuth } from '../contexts/AuthContext';
import { Check, X, Clock, Inbox, ShieldAlert, AlertCircle } from 'lucide-react';

interface Transfer {
  id: string; transfer_number: number; source_name: string; destination_name: string;
  source_masked: string; dest_masked: string; transfer_amount: number; transfer_fee: number;
  total_source_deduction: number; destination_amount: number; status: string;
  transfer_date: string; purpose: string; notes: string;
  created_by_username: string; created_at: string; updated_at: string; failure_reason: string;
}

interface OwnerFund {
  id: string; transaction_number: number; amount: number; net_amount: string; fee: string;
  status: string; transaction_date: string; description: string; notes: string;
  payment_method: string; reference_number: string; created_at: string;
  rejection_reason: string | null; additional_charges: any[];
  type_code: string; type_name: string; direction: string;
  account_name: string; current_balance: string; created_by_username: string;
}

type Source = 'transfers' | 'funds' | 'reversals';
type Tab = 'pending' | 'rejected';

interface Reversal {
  id: string; transaction_number: number; original_amount: string; original_status: string;
  reversal_amount: string; reason: string | null; status: string; created_at: string;
  updated_at: string; requested_by_username: string; decided_by_username: string | null;
  account_name: string; type_name: string; direction: string; description: string | null;
}

const paymentLabel = (m: string) =>
  ({ cash: 'Cash', gcash: 'GCash', bank: 'Bank Transfer', maya: 'Maya' } as Record<string, string>)[m] || m || '—';

export default function TransferApprovals() {
  const { user } = useAuth();
  const isAdmin = user?.roles?.includes('administrator') ?? false;
  const isApprover = isAdmin || user?.roles?.includes('manager');
  const [source, setSource] = useState<Source>('transfers');
  const [tab, setTab] = useState<Tab>('pending');
  const [pending, setPending] = useState<Transfer[]>([]);
  const [rejected, setRejected] = useState<Transfer[]>([]);
  const [fundsPending, setFundsPending] = useState<OwnerFund[]>([]);
  const [fundsRejected, setFundsRejected] = useState<OwnerFund[]>([]);
  const [reversals, setReversals] = useState<Reversal[]>([]);
  const [reversalsRejected, setReversalsRejected] = useState<Reversal[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [rejecting, setRejecting] = useState<{ kind: Source; record: Transfer | OwnerFund | Reversal } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const loadData = useCallback(async () => {
    if (!isApprover) return;
    setLoading(true);
    try {
      const results = await Promise.allSettled([
        api.get<{ data: Transfer[] }>('/transfers?status=pending&limit=50'),
        api.get<{ data: Transfer[] }>('/transfers?status=rejected&limit=20'),
        api.get<{ data: OwnerFund[] } | OwnerFund[]>('/transactions/owner-funds/pending?status=pending'),
        api.get<{ data: OwnerFund[] } | OwnerFund[]>('/transactions/owner-funds/pending?status=rejected'),
        api.get<{ data: Reversal[] } | Reversal[]>('/transactions/reversals/pending?status=pending'),
        api.get<{ data: Reversal[] } | Reversal[]>('/transactions/reversals/pending?status=rejected'),
      ]);
      const value = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? r.value : undefined);
      setPending(unwrapRows<Transfer>(value(results[0])));
      setRejected(unwrapRows<Transfer>(value(results[1])));
      setFundsPending(unwrapRows<OwnerFund>(value(results[2])));
      setFundsRejected(unwrapRows<OwnerFund>(value(results[3])));
      setReversals(unwrapRows<Reversal>(value(results[4])));
      setReversalsRejected(unwrapRows<Reversal>(value(results[5])));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      setLoadError(failed.length > 0
        ? `Could not load ${failed.length} of the ${results.length} approval queues — ${failed[0].reason?.message || 'request failed'}`
        : '');
      window.dispatchEvent(new Event('approvals-changed'));
    } catch (err) {
      console.error('Approvals load error:', err);
      setLoadError(err instanceof Error ? err.message : 'Failed to load approvals');
    } finally {
      setLoading(false);
    }
  }, [isApprover]);

  useEffect(() => { loadData(); }, [loadData]);

  if (!isApprover) {
    return (
      <div className="p-6">
        <div className="bg-white rounded-lg border border-gray-200 p-10 text-center max-w-lg mx-auto">
          <ShieldAlert className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Access denied</h2>
          <p className="text-sm text-gray-500">You don't have permission to approve transfers or owner fund movements. This page is available to administrators and managers.</p>
        </div>
      </div>
    );
  }

  const approveTransfer = async (t: Transfer) => {
    if (!window.confirm(`Approve transfer #${t.transfer_number} — ${formatCurrency(t.total_source_deduction)} will be deducted from ${t.source_name} now?`)) return;
    setBusy(true);
    try {
      await api.post(`/transfers/${t.id}/approve`);
      await loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to approve transfer');
    } finally {
      setBusy(false);
    }
  };

  const approveFund = async (f: OwnerFund) => {
    const isReturn = f.type_code === 'owner_return';
    const verb = isReturn ? 'deducted from' : 'credited to';
    if (!window.confirm(
      `Approve ${f.type_name} #${f.transaction_number} — ${formatCurrency(parseFloat(String(f.amount)))} will be ${verb} ${f.account_name} now?`
    )) return;
    setBusy(true);
    try {
      await api.post(`/transactions/${f.id}/approve`);
      await loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to approve fund movement');
    } finally {
      setBusy(false);
    }
  };

  const approveReversal = async (r: Reversal) => {
    if (!window.confirm(
      `Approve the reversal of transaction #${r.transaction_number} (${r.type_name} on ${r.account_name})? ` +
      `${formatCurrency(parseFloat(String(r.reversal_amount)))} will be reversed and the original record becomes Reversed.`
    )) return;
    setBusy(true);
    try {
      await api.post(`/transactions/reversals/${r.id}/approve`);
      await loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to approve reversal');
    } finally {
      setBusy(false);
    }
  };

  const submitReject = async () => {
    if (!rejecting) return;
    if (!reason.trim()) { alert('Please provide a rejection reason'); return; }
    setBusy(true);
    try {
      const url = rejecting.kind === 'transfers'
        ? `/transfers/${rejecting.record.id}/reject`
        : rejecting.kind === 'reversals'
          ? `/transactions/reversals/${rejecting.record.id}/reject`
          : `/transactions/${rejecting.record.id}/reject`;
      await api.post(url, { reason: reason.trim() });
      setRejecting(null);
      setReason('');
      await loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to reject');
    } finally {
      setBusy(false);
    }
  };

  const rows = source === 'transfers'
    ? { pend: pending, rej: rejected }
    : source === 'funds'
      ? { pend: fundsPending, rej: fundsRejected }
      : { pend: reversals, rej: reversalsRejected };
  const sourceLabel = source === 'transfers' ? 'transfers' : source === 'funds' ? 'fund movements' : 'reversal requests';
  const pendingCount = rows.pend.length;
  const pendingTotal = source === 'transfers'
    ? pending.reduce((sum, t) => sum + parseFloat(String(t.total_source_deduction)), 0)
    : source === 'funds'
      ? fundsPending.reduce((sum, f) => sum + parseFloat(String(f.amount)), 0)
      : reversals.reduce((sum, r) => sum + parseFloat(String(r.reversal_amount)), 0);
  const totalPending = pending.length + fundsPending.length + reversals.length;

  const sources: { key: Source; label: string; count: number }[] = [
    { key: 'transfers', label: 'Transfers', count: pending.length },
    { key: 'funds', label: 'Owner Funds', count: fundsPending.length },
    { key: 'reversals', label: 'Reversals', count: reversals.length },
  ];

  const rejectingLabel = rejecting
    ? rejecting.kind === 'transfers'
      ? `Reject transfer #${(rejecting.record as Transfer).transfer_number}`
      : rejecting.kind === 'reversals'
        ? `Reject reversal request #${(rejecting.record as Reversal).transaction_number}`
        : `Reject ${(rejecting.record as OwnerFund).type_name} #${(rejecting.record as OwnerFund).transaction_number}`
    : '';

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Approvals</h1>
          <p className="text-sm text-gray-500 mt-1">Review pending transfers, owner fund movements and reversal requests. Funds move only when you approve.</p>
        </div>
        <div className="flex gap-3">
          <div className="bg-white border border-gray-200 rounded-lg px-4 py-2 text-center">
            <p className="text-xs text-gray-500">Pending</p>
            <p className="text-lg font-semibold text-amber-600">{totalPending}</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg px-4 py-2 text-center">
            <p className="text-xs text-gray-500">Awaiting decision</p>
            <p className="text-lg font-semibold text-gray-900">{formatCurrency(pendingTotal)}</p>
          </div>
        </div>
      </div>

      {loadError && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm flex items-start justify-between gap-4">
          <span>{loadError}</span>
          <button onClick={() => loadData()} className="shrink-0 font-medium underline hover:no-underline">Retry</button>
        </div>
      )}

      <div className="flex gap-2">
        {sources.map((s) => (
          <button
            key={s.key}
            onClick={() => setSource(s.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
              source === s.key
                ? 'bg-primary-600 border-primary-600 text-white'
                : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {s.label}
            {s.count > 0 && (
              <span className={`ml-2 px-1.5 py-0.5 rounded-full text-xs ${source === s.key ? 'bg-white/20 text-white' : 'bg-amber-100 text-amber-700'}`}>
                {s.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex gap-2 border-b border-gray-200">
        {(['pending', 'rejected'] as const).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === key
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {key === 'pending' ? 'Pending' : 'Rejected'}
            <span className={`ml-2 px-1.5 py-0.5 rounded-full text-xs ${tab === key ? 'bg-primary-100 text-primary-700' : 'bg-gray-100 text-gray-500'}`}>
              {key === 'pending' ? pendingCount : rows.rej.length}
            </span>
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-gray-500">Loading approvals...</div>
        ) : rows.pend.length === 0 && rows.rej.length === 0 ? (
          <div className="p-10 text-center">
            <Inbox className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500">Nothing waiting for you here.</p>
          </div>
        ) : tab === 'pending' ? (
          pendingCount === 0 ? (
            <div className="p-10 text-center">
              <Inbox className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No {sourceLabel} awaiting approval.</p>
            </div>
          ) : source === 'transfers' ? (
            <TransferPendingTable rows={pending} busy={busy} onApprove={approveTransfer} onReject={(t) => { setRejecting({ kind: 'transfers', record: t }); setReason(''); }} />
          ) : source === 'funds' ? (
            <FundPendingTable rows={fundsPending} busy={busy} onApprove={approveFund} onReject={(f) => { setRejecting({ kind: 'funds', record: f }); setReason(''); }} />
          ) : (
            <ReversalPendingTable
              rows={reversals}
              busy={busy}
              canDecide={isAdmin}
              onApprove={approveReversal}
              onReject={(r) => { setRejecting({ kind: 'reversals', record: r }); setReason(''); }}
            />
          )
        ) : rows.rej.length === 0 ? (
          <div className="p-10 text-center">
            <Inbox className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No rejected {sourceLabel}.</p>
          </div>
        ) : source === 'transfers' ? (
          <TransferRejectedTable rows={rejected} />
        ) : source === 'funds' ? (
          <FundRejectedTable rows={fundsRejected} />
        ) : (
          <ReversalRejectedTable rows={reversalsRejected} />
        )}
      </div>

      {rejecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
              <Clock className="w-5 h-5 text-red-500" />
              <h2 className="text-lg font-semibold text-gray-900">{rejectingLabel}</h2>
            </div>
            <div className="px-6 py-4 space-y-4">
              <p className="text-sm text-gray-600">
                {rejecting.kind === 'transfers' ? (
                  <>
                    {formatCurrency((rejecting.record as Transfer).transfer_amount)} from{' '}
                    <strong>{(rejecting.record as Transfer).source_name}</strong> to{' '}
                    <strong>{(rejecting.record as Transfer).destination_name}</strong>. The money will not move.
                  </>
                ) : rejecting.kind === 'reversals' ? (
                  <>
                    Reversal of transaction <strong>#{(rejecting.record as Reversal).transaction_number}</strong> on{' '}
                    <strong>{(rejecting.record as Reversal).account_name}</strong>. The original record stays{' '}
                    <strong>{(rejecting.record as Reversal).original_status}</strong> and no balance changes.
                  </>
                ) : (
                  <>
                    {formatCurrency(parseFloat(String((rejecting.record as OwnerFund).amount)))} for{' '}
                    <strong>{(rejecting.record as OwnerFund).type_name}</strong> on{' '}
                    <strong>{(rejecting.record as OwnerFund).account_name}</strong>. The balance will not change.
                  </>
                )}
              </p>
              <div>
                <label htmlFor="reject-reason" className="block text-sm font-medium text-gray-700 mb-1">Reason (required)</label>
                <textarea
                  id="reject-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  autoFocus
                  placeholder="e.g. Needs owner confirmation, wrong amount, use a different method..."
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button
                onClick={() => { setRejecting(null); setReason(''); }}
                disabled={busy}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={submitReject}
                disabled={busy || !reason.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy ? 'Rejecting...' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionButtons({ busy, onApprove, onReject }: {
  busy: boolean; onApprove: () => void; onReject: () => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2">
      <button
        onClick={onApprove}
        disabled={busy}
        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
      >
        <Check className="w-3.5 h-3.5" /> Approve
      </button>
      <button
        onClick={onReject}
        disabled={busy}
        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 disabled:opacity-50"
      >
        <X className="w-3.5 h-3.5" /> Reject
      </button>
    </div>
  );
}

function TransferPendingTable({ rows, busy, onApprove, onReject }: {
  rows: Transfer[]; busy: boolean; onApprove: (t: Transfer) => void; onReject: (t: Transfer) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            <th className="px-4 py-3 text-left font-medium">#</th>
            <th className="px-4 py-3 text-left font-medium">From → To</th>
            <th className="px-4 py-3 text-right font-medium">Amount</th>
            <th className="px-4 py-3 text-right font-medium">Service Charge</th>
            <th className="px-4 py-3 text-right font-medium">Total Deduction</th>
            <th className="px-4 py-3 text-left font-medium">Purpose</th>
            <th className="px-4 py-3 text-left font-medium">Created By</th>
            <th className="px-4 py-3 text-left font-medium">Submitted</th>
            <th className="px-4 py-3 text-center font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((t) => (
            <tr key={t.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 font-medium text-gray-900">#{t.transfer_number}</td>
              <td className="px-4 py-3">
                <span className="text-gray-900">{t.source_name}</span>
                <span className="text-gray-400 mx-1">→</span>
                <span className="text-gray-900">{t.destination_name}</span>
              </td>
              <td className="px-4 py-3 text-right font-medium">{formatCurrency(t.transfer_amount)}</td>
              <td className="px-4 py-3 text-right text-gray-500">{formatCurrency(t.transfer_fee)}</td>
              <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatCurrency(t.total_source_deduction)}</td>
              <td className="px-4 py-3 text-gray-500 max-w-[180px] truncate">{t.purpose || '—'}</td>
              <td className="px-4 py-3 text-gray-700">{t.created_by_username || '—'}</td>
              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{new Date(t.created_at).toLocaleString()}</td>
              <td className="px-4 py-3">
                <ActionButtons busy={busy} onApprove={() => onApprove(t)} onReject={() => onReject(t)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TransferRejectedTable({ rows }: { rows: Transfer[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            <th className="px-4 py-3 text-left font-medium">#</th>
            <th className="px-4 py-3 text-left font-medium">From → To</th>
            <th className="px-4 py-3 text-right font-medium">Amount</th>
            <th className="px-4 py-3 text-left font-medium">Created By</th>
            <th className="px-4 py-3 text-left font-medium">Reason</th>
            <th className="px-4 py-3 text-left font-medium">Rejected</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((t) => (
            <tr key={t.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 font-medium text-gray-900">#{t.transfer_number}</td>
              <td className="px-4 py-3">
                <span className="text-gray-900">{t.source_name}</span>
                <span className="text-gray-400 mx-1">→</span>
                <span className="text-gray-900">{t.destination_name}</span>
              </td>
              <td className="px-4 py-3 text-right font-medium">{formatCurrency(t.transfer_amount)}</td>
              <td className="px-4 py-3 text-gray-700">{t.created_by_username || '—'}</td>
              <td className="px-4 py-3 text-red-600 max-w-[260px]">
                <span className="inline-flex items-start gap-1">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  {t.failure_reason}
                </span>
              </td>
              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{new Date(t.updated_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FundPendingTable({ rows, busy, onApprove, onReject }: {
  rows: OwnerFund[]; busy: boolean; onApprove: (f: OwnerFund) => void; onReject: (f: OwnerFund) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            <th className="px-4 py-3 text-left font-medium">#</th>
            <th className="px-4 py-3 text-left font-medium">Type</th>
            <th className="px-4 py-3 text-left font-medium">Account</th>
            <th className="px-4 py-3 text-right font-medium">Amount</th>
            <th className="px-4 py-3 text-right font-medium">Balance After</th>
            <th className="px-4 py-3 text-left font-medium">Method</th>
            <th className="px-4 py-3 text-left font-medium">Date</th>
            <th className="px-4 py-3 text-left font-medium">Created By</th>
            <th className="px-4 py-3 text-center font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((f) => {
            const amount = parseFloat(String(f.amount));
            const isReturn = f.type_code === 'owner_return';
            const balanceAfter = parseFloat(String(f.current_balance)) + (isReturn ? -amount : amount);
            return (
              <tr key={f.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">#{f.transaction_number}</td>
                <td className="px-4 py-3">
                  <span className={`badge-${isReturn ? 'red' : 'green'}`}>{f.type_name}</span>
                </td>
                <td className="px-4 py-3 text-gray-900">{f.account_name}</td>
                <td className={`px-4 py-3 text-right font-semibold ${isReturn ? 'text-red-600' : 'text-green-600'}`}>
                  {isReturn ? '−' : '+'}{formatCurrency(amount)}
                </td>
                <td className="px-4 py-3 text-right text-gray-700">{formatCurrency(balanceAfter)}</td>
                <td className="px-4 py-3 text-gray-700">{paymentLabel(f.payment_method)}</td>
                <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{new Date(f.transaction_date).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-gray-700">{f.created_by_username || '—'}</td>
                <td className="px-4 py-3">
                  <ActionButtons busy={busy} onApprove={() => onApprove(f)} onReject={() => onReject(f)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FundRejectedTable({ rows }: { rows: OwnerFund[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            <th className="px-4 py-3 text-left font-medium">#</th>
            <th className="px-4 py-3 text-left font-medium">Type</th>
            <th className="px-4 py-3 text-left font-medium">Account</th>
            <th className="px-4 py-3 text-right font-medium">Amount</th>
            <th className="px-4 py-3 text-left font-medium">Created By</th>
            <th className="px-4 py-3 text-left font-medium">Reason</th>
            <th className="px-4 py-3 text-left font-medium">Rejected</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((f) => (
            <tr key={f.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 font-medium text-gray-900">#{f.transaction_number}</td>
              <td className="px-4 py-3">
                <span className={`badge-${f.type_code === 'owner_return' ? 'red' : 'green'}`}>{f.type_name}</span>
              </td>
              <td className="px-4 py-3 text-gray-900">{f.account_name}</td>
              <td className="px-4 py-3 text-right font-medium">{formatCurrency(parseFloat(String(f.amount)))}</td>
              <td className="px-4 py-3 text-gray-700">{f.created_by_username || '—'}</td>
              <td className="px-4 py-3 text-red-600 max-w-[260px]">
                <span className="inline-flex items-start gap-1">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  {f.rejection_reason || '—'}
                </span>
              </td>
              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{new Date(f.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReversalPendingTable({ rows, busy, canDecide, onApprove, onReject }: {
  rows: Reversal[]; busy: boolean; canDecide: boolean;
  onApprove: (r: Reversal) => void; onReject: (r: Reversal) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            <th className="px-4 py-3 text-left font-medium">Tx#</th>
            <th className="px-4 py-3 text-left font-medium">Type</th>
            <th className="px-4 py-3 text-left font-medium">Account</th>
            <th className="px-4 py-3 text-right font-medium">Original</th>
            <th className="px-4 py-3 text-right font-medium">Balance Impact</th>
            <th className="px-4 py-3 text-left font-medium">Reason</th>
            <th className="px-4 py-3 text-left font-medium">Requested By</th>
            <th className="px-4 py-3 text-left font-medium">Requested</th>
            <th className="px-4 py-3 text-center font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => {
            const impact = parseFloat(String(r.reversal_amount));
            const reversesIn = r.direction === 'in';
            return (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">#{r.transaction_number}</td>
                <td className="px-4 py-3">
                  <span className={`badge-${reversesIn ? 'red' : 'green'}`}>{r.type_name}</span>
                </td>
                <td className="px-4 py-3 text-gray-900">{r.account_name}</td>
                <td className="px-4 py-3 text-right text-gray-700">{formatCurrency(parseFloat(String(r.original_amount)))}</td>
                <td
                  className={`px-4 py-3 text-right font-semibold ${reversesIn ? 'text-red-600' : 'text-green-600'}`}
                  title="Balance change once approved"
                >
                  {reversesIn ? '−' : '+'}{formatCurrency(impact)}
                </td>
                <td className="px-4 py-3 text-gray-500 max-w-[240px]">
                  <span className="block truncate" title={r.reason || r.description || ''}>
                    {r.reason || r.description || '—'}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-700">{r.requested_by_username || '—'}</td>
                <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
                <td className="px-4 py-3">
                  {canDecide
                    ? <ActionButtons busy={busy} onApprove={() => onApprove(r)} onReject={() => onReject(r)} />
                    : <span className="text-xs text-gray-400 whitespace-nowrap">Administrator only</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReversalRejectedTable({ rows }: { rows: Reversal[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            <th className="px-4 py-3 text-left font-medium">Tx#</th>
            <th className="px-4 py-3 text-left font-medium">Type</th>
            <th className="px-4 py-3 text-left font-medium">Account</th>
            <th className="px-4 py-3 text-right font-medium">Original</th>
            <th className="px-4 py-3 text-left font-medium">Requested By</th>
            <th className="px-4 py-3 text-left font-medium">Reason</th>
            <th className="px-4 py-3 text-left font-medium">Rejected By</th>
            <th className="px-4 py-3 text-left font-medium">Rejected</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 font-medium text-gray-900">#{r.transaction_number}</td>
              <td className="px-4 py-3">{r.type_name}</td>
              <td className="px-4 py-3 text-gray-900">{r.account_name}</td>
              <td className="px-4 py-3 text-right text-gray-700">{formatCurrency(parseFloat(String(r.original_amount)))}</td>
              <td className="px-4 py-3 text-gray-700">{r.requested_by_username || '—'}</td>
              <td className="px-4 py-3 text-red-600 max-w-[260px]">
                <span className="inline-flex items-start gap-1">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  {r.reason || '—'}
                </span>
              </td>
              <td className="px-4 py-3 text-gray-700">{r.decided_by_username || '—'}</td>
              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{new Date(r.updated_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
