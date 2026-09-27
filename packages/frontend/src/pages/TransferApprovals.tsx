import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
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

type Source = 'transfers' | 'funds';
type Tab = 'pending' | 'rejected';

const paymentLabel = (m: string) =>
  ({ cash: 'Cash', gcash: 'GCash', bank: 'Bank Transfer', maya: 'Maya' } as Record<string, string>)[m] || m || '—';

export default function TransferApprovals() {
  const { user } = useAuth();
  const isApprover = user?.roles?.includes('administrator') || user?.roles?.includes('manager');
  const [source, setSource] = useState<Source>('transfers');
  const [tab, setTab] = useState<Tab>('pending');
  const [pending, setPending] = useState<Transfer[]>([]);
  const [rejected, setRejected] = useState<Transfer[]>([]);
  const [fundsPending, setFundsPending] = useState<OwnerFund[]>([]);
  const [fundsRejected, setFundsRejected] = useState<OwnerFund[]>([]);
  const [loading, setLoading] = useState(true);
  const [rejecting, setRejecting] = useState<{ kind: Source; record: Transfer | OwnerFund } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const loadData = useCallback(async () => {
    if (!isApprover) return;
    setLoading(true);
    try {
      const [p, r, fp, fr] = await Promise.all([
        api.get<{ data: Transfer[] }>('/transfers?status=pending&limit=50'),
        api.get<{ data: Transfer[] }>('/transfers?status=rejected&limit=20'),
        api.get<{ data: OwnerFund[] }>('/transactions/owner-funds/pending?status=pending'),
        api.get<{ data: OwnerFund[] }>('/transactions/owner-funds/pending?status=rejected'),
      ]);
      setPending(p.data);
      setRejected(r.data);
      setFundsPending(fp.data);
      setFundsRejected(fr.data);
      window.dispatchEvent(new Event('approvals-changed'));
    } catch (err) {
      console.error('Approvals load error:', err);
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

  const submitReject = async () => {
    if (!rejecting) return;
    if (!reason.trim()) { alert('Please provide a rejection reason'); return; }
    setBusy(true);
    try {
      const url = rejecting.kind === 'transfers'
        ? `/transfers/${rejecting.record.id}/reject`
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
    : { pend: fundsPending, rej: fundsRejected };
  const pendingCount = rows.pend.length;
  const pendingTotal = source === 'transfers'
    ? pending.reduce((sum, t) => sum + parseFloat(String(t.total_source_deduction)), 0)
    : fundsPending.reduce((sum, f) => sum + parseFloat(String(f.amount)), 0);
  const totalPending = pending.length + fundsPending.length;

  const sources: { key: Source; label: string; count: number }[] = [
    { key: 'transfers', label: 'Transfers', count: pending.length },
    { key: 'funds', label: 'Owner Funds', count: fundsPending.length },
  ];

  const rejectingLabel = rejecting
    ? rejecting.kind === 'transfers'
      ? `Reject transfer #${(rejecting.record as Transfer).transfer_number}`
      : `Reject ${(rejecting.record as OwnerFund).type_name} #${(rejecting.record as OwnerFund).transaction_number}`
    : '';

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Approvals</h1>
          <p className="text-sm text-gray-500 mt-1">Review pending transfers and owner fund movements. Funds move only when you approve.</p>
        </div>
        <div className="flex gap-3">
          <div className="bg-white border border-gray-200 rounded-lg px-4 py-2 text-center">
            <p className="text-xs text-gray-500">Pending</p>
            <p className="text-lg font-semibold text-amber-600">{totalPending}</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg px-4 py-2 text-center">
            <p className="text-xs text-gray-500">{source === 'transfers' ? 'Awaiting decision' : 'Awaiting decision'}</p>
            <p className="text-lg font-semibold text-gray-900">{formatCurrency(pendingTotal)}</p>
          </div>
        </div>
      </div>

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
              <p className="text-sm text-gray-500">No {source === 'transfers' ? 'transfers' : 'fund movements'} awaiting approval.</p>
            </div>
          ) : source === 'transfers' ? (
            <TransferPendingTable rows={pending} busy={busy} onApprove={approveTransfer} onReject={(t) => { setRejecting({ kind: 'transfers', record: t }); setReason(''); }} />
          ) : (
            <FundPendingTable rows={fundsPending} busy={busy} onApprove={approveFund} onReject={(f) => { setRejecting({ kind: 'funds', record: f }); setReason(''); }} />
          )
        ) : rows.rej.length === 0 ? (
          <div className="p-10 text-center">
            <Inbox className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No rejected {source === 'transfers' ? 'transfers' : 'fund movements'}.</p>
          </div>
        ) : source === 'transfers' ? (
          <TransferRejectedTable rows={rejected} />
        ) : (
          <FundRejectedTable rows={fundsRejected} />
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
