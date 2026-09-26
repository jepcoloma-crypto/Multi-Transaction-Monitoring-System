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

export default function TransferApprovals() {
  const { user } = useAuth();
  const isApprover = user?.roles?.includes('administrator') || user?.roles?.includes('manager');
  const [tab, setTab] = useState<'pending' | 'rejected'>('pending');
  const [pending, setPending] = useState<Transfer[]>([]);
  const [rejected, setRejected] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [rejecting, setRejecting] = useState<Transfer | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const loadData = useCallback(async () => {
    if (!isApprover) return;
    setLoading(true);
    try {
      const [p, r] = await Promise.all([
        api.get<{ data: Transfer[] }>('/transfers?status=pending&limit=50'),
        api.get<{ data: Transfer[] }>('/transfers?status=rejected&limit=20'),
      ]);
      setPending(p.data);
      setRejected(r.data);
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
          <p className="text-sm text-gray-500">You don't have permission to approve fund transfers. This page is available to administrators and managers.</p>
        </div>
      </div>
    );
  }

  const handleApprove = async (t: Transfer) => {
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

  const submitReject = async () => {
    if (!rejecting) return;
    if (!reason.trim()) { alert('Please provide a rejection reason'); return; }
    setBusy(true);
    try {
      await api.post(`/transfers/${rejecting.id}/reject`, { reason: reason.trim() });
      setRejecting(null);
      setReason('');
      await loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to reject transfer');
    } finally {
      setBusy(false);
    }
  };

  const pendingTotal = pending.reduce((sum, t) => sum + parseFloat(String(t.total_source_deduction)), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Transfer Approvals</h1>
          <p className="text-sm text-gray-500 mt-1">Review pending fund transfers. Funds move only when you approve.</p>
        </div>
        <div className="flex gap-3">
          <div className="bg-white border border-gray-200 rounded-lg px-4 py-2 text-center">
            <p className="text-xs text-gray-500">Pending</p>
            <p className="text-lg font-semibold text-amber-600">{pending.length}</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg px-4 py-2 text-center">
            <p className="text-xs text-gray-500">Amount awaiting decision</p>
            <p className="text-lg font-semibold text-gray-900">{formatCurrency(pendingTotal)}</p>
          </div>
        </div>
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
              {key === 'pending' ? pending.length : rejected.length}
            </span>
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-gray-500">Loading transfers...</div>
        ) : tab === 'pending' ? (
          pending.length === 0 ? (
            <div className="p-10 text-center">
              <Inbox className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No transfers awaiting approval.</p>
            </div>
          ) : (
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
                  {pending.map((t) => (
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
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => handleApprove(t)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                          >
                            <Check className="w-3.5 h-3.5" /> Approve
                          </button>
                          <button
                            onClick={() => { setRejecting(t); setReason(''); }}
                            disabled={busy}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 disabled:opacity-50"
                          >
                            <X className="w-3.5 h-3.5" /> Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : rejected.length === 0 ? (
          <div className="p-10 text-center">
            <Inbox className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No rejected transfers.</p>
          </div>
        ) : (
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
                {rejected.map((t) => (
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
        )}
      </div>

      {rejecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
              <Clock className="w-5 h-5 text-red-500" />
              <h2 className="text-lg font-semibold text-gray-900">Reject transfer #{rejecting.transfer_number}</h2>
            </div>
            <div className="px-6 py-4 space-y-4">
              <p className="text-sm text-gray-600">
                {formatCurrency(rejecting.transfer_amount)} from <strong>{rejecting.source_name}</strong> to{' '}
                <strong>{rejecting.destination_name}</strong>. The money will not move.
              </p>
              <div>
                <label htmlFor="reject-reason" className="block text-sm font-medium text-gray-700 mb-1">Reason (required)</label>
                <textarea
                  id="reject-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  autoFocus
                  placeholder="e.g. Incorrect destination account, amount needs confirmation..."
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
                {busy ? 'Rejecting...' : 'Reject Transfer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
