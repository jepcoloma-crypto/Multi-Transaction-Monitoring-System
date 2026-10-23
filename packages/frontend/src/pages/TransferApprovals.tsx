import { useState, useEffect, useCallback } from 'react';
import { api, unwrapRows } from '../lib/api';
import { formatCurrency, manilaDayLabel, manilaDateTimeLabel, transactionTypeLabel } from '../lib/format';
import { useAuth } from '../contexts/AuthContext';
import { Check, X, Clock, Inbox, ShieldAlert, AlertCircle } from 'lucide-react';

interface Transfer {
  id: string; transfer_number: number; transfer_reference: string; source_name: string; destination_name: string;
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

interface CashEvent {
  id: string; transaction_number: number; amount: number; status: string;
  transaction_date: string; description: string | null; notes: string | null;
  reference_number: string | null; payee: string | null; created_at: string;
  updated_at: string | null; rejection_reason: string | null;
  type_code: string; type_name: string; direction: string;
  account_name: string; current_balance: string; branch_name: string;
  requested_by_username: string | null; approved_by_username: string | null; rejected_by_username: string | null;
}

type Source = 'transfers' | 'funds' | 'reversals' | 'cash';
type Tab = 'pending' | 'rejected';

interface Reversal {
  id: string; transaction_number: number; original_amount: string; original_status: string;
  reversal_amount: string; reason: string | null; status: string; created_at: string;
  updated_at: string; requested_by_username: string; decided_by_username: string | null;
  account_name: string; type_name: string; type_code?: string | null; direction?: string | null;
  description: string | null; entity_type?: string | null;
}

// The approval's impact preview: every account the decision touches, where its
// balance stands now, what approval does to it, and every guard that would
// refuse — the same plan the approval commits through, so what the dialog
// shows is what the button will post.
interface PreviewImpact { accountId: string; name: string; before: number; delta: number; after: number; }
interface PreviewData {
  record: {
    kind: 'transaction' | 'loading';
    number: number; status: string; typeCode: string | null; typeName: string;
    accountName: string; description: string | null; date: string | null;
  };
  affected: PreviewImpact[];
  rowsToAppend: Array<{ name: string; entryType: string; amount: number }>;
  notes: string[];
  problems: string[];
  shift: { open: boolean; message: string | null };
  safeToApply: boolean;
  request: {
    id: string; entityType: string; status: string; reason: string | null;
    requestedBy: string; requestedByUsername: string; reversalAmount: number;
    createdAt: string; isOwnRequest: boolean;
  };
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
  const [cashPending, setCashPending] = useState<CashEvent[]>([]);
  const [cashRejected, setCashRejected] = useState<CashEvent[]>([]);
  const [reversals, setReversals] = useState<Reversal[]>([]);
  const [reversalsRejected, setReversalsRejected] = useState<Reversal[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [rejecting, setRejecting] = useState<{ kind: Source; record: Transfer | OwnerFund | Reversal | CashEvent } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState<Reversal | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

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
        api.get<{ data: CashEvent[] } | CashEvent[]>('/cash-management/events/pending?status=pending'),
        api.get<{ data: CashEvent[] } | CashEvent[]>('/cash-management/events/pending?status=rejected'),
      ]);
      const value = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? r.value : undefined);
      setPending(unwrapRows<Transfer>(value(results[0])));
      setRejected(unwrapRows<Transfer>(value(results[1])));
      setFundsPending(unwrapRows<OwnerFund>(value(results[2])));
      setFundsRejected(unwrapRows<OwnerFund>(value(results[3])));
      setReversals(unwrapRows<Reversal>(value(results[4])));
      setReversalsRejected(unwrapRows<Reversal>(value(results[5])));
      setCashPending(unwrapRows<CashEvent>(value(results[6])));
      setCashRejected(unwrapRows<CashEvent>(value(results[7])));
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
          <p className="text-sm text-gray-500">You don't have permission to approve transfers, owner fund movements, cash events or reversal requests. This page is available to administrators and managers.</p>
        </div>
      </div>
    );
  }

  const approveTransfer = async (t: Transfer) => {
    if (!window.confirm(`Approve transfer ${t.transfer_reference} — ${formatCurrency(t.total_source_deduction)} will be deducted from ${t.source_name} now?`)) return;
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
      `Approve ${transactionTypeLabel(f.type_code, f.type_name)} #${f.transaction_number} — ${formatCurrency(parseFloat(String(f.amount)))} will be ${verb} ${f.account_name} now?`
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

  // Cash events (adjustments and borrowings) move money opposite ways, so the
  // confirm has to say which: an adjustment in or a loan received credits the
  // account, an adjustment out or a loan repayment debits it.
  const approveCashEvent = async (c: CashEvent) => {
    const credit = c.direction === 'in' || c.direction === 'adjustment';
    if (!window.confirm(
      `Approve ${transactionTypeLabel(c.type_code, c.type_name)} #${c.transaction_number} — ${formatCurrency(parseFloat(String(c.amount)))} will be ${credit ? 'credited to' : 'deducted from'} ${c.account_name} now?`
    )) return;
    setBusy(true);
    try {
      await api.post(`/transactions/${c.id}/approve`);
      await loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to approve cash event');
    } finally {
      setBusy(false);
    }
  };

  // Approve opens the impact preview first — what the approval will touch is
  // read before money moves, not confirmed with a sentence in a popup.
  const openPreview = async (r: Reversal) => {
    setPreviewing(r);
    setPreview(null);
    setPreviewError('');
    setPreviewLoading(true);
    try {
      const body = (await api.get<unknown>(`/transactions/reversals/${r.id}/preview`)) as any;
      setPreview(body?.data ?? body);
    } catch (err: any) {
      setPreviewError(err.message || 'Could not load the impact preview');
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    setPreviewing(null);
    setPreview(null);
    setPreviewError('');
  };

  const approveFromPreview = async () => {
    if (!previewing) return;
    setBusy(true);
    try {
      const body = (await api.post(`/transactions/reversals/${previewing.id}/approve`)) as any;
      // The server reports the balances it actually committed — shown back so
      // the approval is checked after the fact as well as before it.
      const affected = body?.data?.affected as Array<{ name: string; balance?: number | string; after?: number }> | undefined;
      closePreview();
      await loadData();
      if (affected && affected.length > 0) {
        alert('Approved. Affected balances: ' + affected
          .map((a) => `${a.name}: ${formatCurrency(Number(a.balance ?? a.after))}`)
          .join(', '));
      }
    } catch (err: any) {
      alert(err.message || 'Failed to approve');
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
      : source === 'cash'
        ? { pend: cashPending, rej: cashRejected }
        : { pend: reversals, rej: reversalsRejected };
  const sourceLabel = source === 'transfers' ? 'transfers' : source === 'funds' ? 'fund movements' : source === 'cash' ? 'cash events' : 'reversal requests';
  const pendingCount = rows.pend.length;
  const pendingTotal = source === 'transfers'
    ? pending.reduce((sum, t) => sum + parseFloat(String(t.total_source_deduction)), 0)
    : source === 'funds'
      ? fundsPending.reduce((sum, f) => sum + parseFloat(String(f.amount)), 0)
      : source === 'cash'
        ? cashPending.reduce((sum, c) => sum + parseFloat(String(c.amount)), 0)
        : reversals.reduce((sum, r) => sum + parseFloat(String(r.reversal_amount)), 0);
  const totalPending = pending.length + fundsPending.length + reversals.length + cashPending.length;

  const sources: { key: Source; label: string; count: number }[] = [
    { key: 'transfers', label: 'Transfers', count: pending.length },
    { key: 'funds', label: 'Owner Funds', count: fundsPending.length },
    { key: 'cash', label: 'Cash Events', count: cashPending.length },
    { key: 'reversals', label: 'Reversals', count: reversals.length },
  ];

  const rejectingLabel = rejecting
    ? rejecting.kind === 'transfers'
      ? `Reject transfer ${(rejecting.record as Transfer).transfer_reference}`
      : rejecting.kind === 'reversals'
        ? (rejecting.record as Reversal).entity_type === 'loading'
          ? `Reject cancellation request #${(rejecting.record as Reversal).transaction_number}`
          : `Reject reversal request #${(rejecting.record as Reversal).transaction_number}`
        : rejecting.kind === 'cash'
          ? `Reject ${transactionTypeLabel((rejecting.record as CashEvent).type_code, (rejecting.record as CashEvent).type_name)} #${(rejecting.record as CashEvent).transaction_number}`
          : `Reject ${transactionTypeLabel((rejecting.record as OwnerFund).type_code, (rejecting.record as OwnerFund).type_name)} #${(rejecting.record as OwnerFund).transaction_number}`
    : '';

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Approvals</h1>
          <p className="text-sm text-gray-500 mt-1">Review pending transfers, owner fund movements, cash events and reversal requests. Funds move only when you approve.</p>
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
          ) : source === 'cash' ? (
            <CashEventPendingTable
              rows={cashPending}
              busy={busy}
              canDecide={isAdmin}
              onApprove={approveCashEvent}
              onReject={(c) => { setRejecting({ kind: 'cash', record: c }); setReason(''); }}
            />
          ) : (
            <ReversalPendingTable
              rows={reversals}
              busy={busy}
              canDecide={isAdmin}
              onApprove={openPreview}
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
        ) : source === 'cash' ? (
          <CashEventRejectedTable rows={cashRejected} />
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
                  (rejecting.record as Reversal).entity_type === 'loading' ? (
                    <>
                      Cancellation of loading sale <strong>#{(rejecting.record as Reversal).transaction_number}</strong> on{' '}
                      <strong>{(rejecting.record as Reversal).account_name}</strong>. The original record stays{' '}
                      <strong>{(rejecting.record as Reversal).original_status}</strong> and no balance changes.
                    </>
                  ) : (
                    <>
                      Reversal of transaction <strong>#{(rejecting.record as Reversal).transaction_number}</strong> on{' '}
                      <strong>{(rejecting.record as Reversal).account_name}</strong>. The original record stays{' '}
                      <strong>{(rejecting.record as Reversal).original_status}</strong> and no balance changes.
                    </>
                  )
                ) : rejecting.kind === 'cash' ? (
                  <>
                    {formatCurrency(parseFloat(String((rejecting.record as CashEvent).amount)))} for{' '}
                    <strong>{transactionTypeLabel((rejecting.record as CashEvent).type_code, (rejecting.record as CashEvent).type_name)}</strong> on{' '}
                    <strong>{(rejecting.record as CashEvent).account_name}</strong>. The balance will not change.
                  </>
                ) : (
                  <>
                    {formatCurrency(parseFloat(String((rejecting.record as OwnerFund).amount)))} for{' '}
                    <strong>{transactionTypeLabel((rejecting.record as OwnerFund).type_code, (rejecting.record as OwnerFund).type_name)}</strong> on{' '}
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

      {previewing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-amber-500" />
              <h2 className="text-lg font-semibold text-gray-900">
                {previewing.entity_type === 'loading' ? 'Cancel loading sale' : 'Reverse transaction'} #{previewing.transaction_number}
              </h2>
            </div>

            <div className="px-6 py-4 space-y-4 text-sm">
              {previewLoading ? (
                <p className="text-gray-500 py-8 text-center">Checking every affected account...</p>
              ) : previewError ? (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3">{previewError}</div>
              ) : preview ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs text-gray-500">Requested by</p>
                      <p className="text-gray-900">{preview.request.requestedByUsername}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Requested</p>
                      <p className="text-gray-900">{manilaDateTimeLabel(preview.request.createdAt)}</p>
                    </div>
                  </div>

                  <div>
                    <p className="text-xs text-gray-500 mb-1">Reason</p>
                    <p className="text-gray-900 bg-gray-50 rounded-lg px-3 py-2">{preview.request.reason || '—'}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs text-gray-500">Record</p>
                      <p className="text-gray-900">
                        {transactionTypeLabel(preview.record.typeCode, preview.record.typeName)} #{preview.record.number}{' '}
                        <span className="text-gray-400">({preview.record.status})</span>
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Account</p>
                      <p className="text-gray-900">{preview.record.accountName}</p>
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-medium text-gray-700 mb-1">Affected balances — what approval will change</p>
                    <div className="border border-gray-200 rounded-lg overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-500">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium">Account</th>
                            <th className="px-3 py-2 text-right font-medium">Now</th>
                            <th className="px-3 py-2 text-right font-medium">Change</th>
                            <th className="px-3 py-2 text-right font-medium">After</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {preview.affected.map((a) => (
                            <tr key={a.accountId}>
                              <td className="px-3 py-2 text-gray-900">{a.name}</td>
                              <td className="px-3 py-2 text-right text-gray-700">{formatCurrency(a.before)}</td>
                              <td className={`px-3 py-2 text-right font-medium ${a.delta >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                {a.delta >= 0 ? '+' : '\u2212'}{formatCurrency(Math.abs(a.delta))}
                              </td>
                              <td className="px-3 py-2 text-right font-semibold text-gray-900">{formatCurrency(a.after)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-medium text-gray-700 mb-1">
                      Rows to append ({preview.rowsToAppend.length}) — nothing existing is rewritten
                    </p>
                    <ul className="space-y-1">
                      {preview.rowsToAppend.map((r, i) => (
                        <li key={i} className="flex justify-between bg-gray-50 rounded px-3 py-1.5">
                          <span className="text-gray-700">{r.name}</span>
                          <span className={`font-medium ${r.entryType === 'credit' ? 'text-green-600' : 'text-red-600'}`}>
                            {r.entryType === 'credit' ? '+' : '\u2212'}{formatCurrency(r.amount)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {preview.notes.map((n, i) => (
                    <div key={i} className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">{n}</div>
                  ))}

                  <div className={`rounded-lg px-3 py-2 ${preview.safeToApply
                    ? 'bg-green-50 border border-green-200 text-green-800'
                    : 'bg-red-50 border border-red-200 text-red-700'}`}>
                    <p className="font-medium mb-1">
                      {preview.safeToApply ? 'All checks passed' : 'This approval would be refused:'}
                    </p>
                    {preview.safeToApply ? (
                      <p className="text-xs">
                        Money moves only on approval — and the commit re-audits every affected account,
                        rolling the whole thing back if any of them does not reconcile.
                      </p>
                    ) : (
                      <ul className="list-disc list-inside space-y-0.5">
                        {!preview.shift.open && <li>{preview.shift.message}</li>}
                        {preview.problems.map((p, i) => <li key={i}>{p}</li>)}
                      </ul>
                    )}
                  </div>
                </>
              ) : null}
            </div>

            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button
                onClick={closePreview}
                disabled={busy}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
              >
                Close
              </button>
              <button
                onClick={approveFromPreview}
                disabled={busy || previewLoading || !preview?.safeToApply}
                title={!preview?.safeToApply ? 'The approval would be refused — see the reasons above' : undefined}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
              >
                {busy ? 'Approving...' : previewing.entity_type === 'loading' ? 'Approve cancellation' : 'Approve reversal'}
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
              <td className="px-4 py-3 font-medium text-gray-900 font-mono">{t.transfer_reference}</td>
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
              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{manilaDateTimeLabel(t.created_at)}</td>
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
              <td className="px-4 py-3 font-medium text-gray-900 font-mono">{t.transfer_reference}</td>
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
              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{manilaDateTimeLabel(t.updated_at)}</td>
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
                  <span className={`badge-${isReturn ? 'red' : 'green'}`}>{transactionTypeLabel(f.type_code, f.type_name)}</span>
                </td>
                <td className="px-4 py-3 text-gray-900">{f.account_name}</td>
                <td className={`px-4 py-3 text-right font-semibold ${isReturn ? 'text-red-600' : 'text-green-600'}`}>
                  {isReturn ? '−' : '+'}{formatCurrency(amount)}
                </td>
                <td className="px-4 py-3 text-right text-gray-700">{formatCurrency(balanceAfter)}</td>
                <td className="px-4 py-3 text-gray-700">{paymentLabel(f.payment_method)}</td>
                <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{manilaDayLabel(f.transaction_date)}</td>
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
                <span className={`badge-${f.type_code === 'owner_return' ? 'red' : 'green'}`}>{transactionTypeLabel(f.type_code, f.type_name)}</span>
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
              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{manilaDateTimeLabel(f.created_at)}</td>
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
                  <span className={`badge-${reversesIn ? 'red' : 'green'}`}>{transactionTypeLabel(r.type_code, r.type_name)}</span>
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
                <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{manilaDateTimeLabel(r.created_at)}</td>
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
              <td className="px-4 py-3">{transactionTypeLabel(r.type_code, r.type_name)}</td>
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
              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{manilaDateTimeLabel(r.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CashEventPendingTable({ rows, busy, canDecide, onApprove, onReject }: {
  rows: CashEvent[]; busy: boolean; canDecide: boolean;
  onApprove: (c: CashEvent) => void; onReject: (c: CashEvent) => void;
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
            <th className="px-4 py-3 text-left font-medium">Payee</th>
            <th className="px-4 py-3 text-left font-medium">Description</th>
            <th className="px-4 py-3 text-left font-medium">Date</th>
            <th className="px-4 py-3 text-left font-medium">Created By</th>
            <th className="px-4 py-3 text-center font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((c) => {
            const credit = c.direction === 'in' || c.direction === 'adjustment';
            return (
              <tr key={c.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">#{c.transaction_number}</td>
                <td className="px-4 py-3">
                  <span className={`badge-${credit ? 'green' : 'red'}`}>{transactionTypeLabel(c.type_code, c.type_name)}</span>
                </td>
                <td className="px-4 py-3 text-gray-900">
                  {c.account_name}
                  <span className="text-gray-400"> · {c.branch_name}</span>
                </td>
                <td className={`px-4 py-3 text-right font-semibold ${credit ? 'text-green-600' : 'text-red-600'}`}>
                  {credit ? '+' : '−'}{formatCurrency(parseFloat(String(c.amount)))}
                </td>
                <td className="px-4 py-3 text-gray-700">{c.payee || '—'}</td>
                <td className="px-4 py-3 text-gray-500 max-w-[220px] truncate" title={c.description || ''}>{c.description || '—'}</td>
                <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{manilaDayLabel(c.transaction_date)}</td>
                <td className="px-4 py-3 text-gray-700">{c.requested_by_username || '—'}</td>
                <td className="px-4 py-3">
                  {canDecide
                    ? <ActionButtons busy={busy} onApprove={() => onApprove(c)} onReject={() => onReject(c)} />
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

function CashEventRejectedTable({ rows }: { rows: CashEvent[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            <th className="px-4 py-3 text-left font-medium">#</th>
            <th className="px-4 py-3 text-left font-medium">Type</th>
            <th className="px-4 py-3 text-left font-medium">Account</th>
            <th className="px-4 py-3 text-right font-medium">Amount</th>
            <th className="px-4 py-3 text-left font-medium">Requested By</th>
            <th className="px-4 py-3 text-left font-medium">Reason</th>
            <th className="px-4 py-3 text-left font-medium">Rejected By</th>
            <th className="px-4 py-3 text-left font-medium">Rejected</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((c) => (
            <tr key={c.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 font-medium text-gray-900">#{c.transaction_number}</td>
              <td className="px-4 py-3">{transactionTypeLabel(c.type_code, c.type_name)}</td>
              <td className="px-4 py-3 text-gray-900">{c.account_name}</td>
              <td className="px-4 py-3 text-right font-medium">{formatCurrency(parseFloat(String(c.amount)))}</td>
              <td className="px-4 py-3 text-gray-700">{c.requested_by_username || '—'}</td>
              <td className="px-4 py-3 text-red-600 max-w-[260px]">
                <span className="inline-flex items-start gap-1">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  {c.rejection_reason || '—'}
                </span>
              </td>
              <td className="px-4 py-3 text-gray-700">{c.rejected_by_username || '—'}</td>
              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{c.updated_at ? manilaDateTimeLabel(c.updated_at) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
