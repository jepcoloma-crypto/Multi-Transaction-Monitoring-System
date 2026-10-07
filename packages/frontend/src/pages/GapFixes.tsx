import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { formatCurrency, manilaDateTimeLabel } from '../lib/format';
import { useAuth } from '../contexts/AuthContext';
import {
  ShieldAlert, Inbox, Plus, Check, X, AlertTriangle, RefreshCw, Activity,
} from 'lucide-react';

interface LedgerAccount {
  id: string; name: string; status: string;
  openingBalance: number; netMovement: number; expectedBalance: number;
  currentBalance: number; gap: number; entryCount: number;
  chainBreaks: number; negativeBalances: number; unlinkedEntries: number;
  lastLedgerBalance: number | null; issues: string[]; reconciled: boolean;
}

interface AuditSummary {
  totalAccounts: number; reconciled: number; mismatched: number;
  totalGap: number; brokenChainLinks: number; negativeBalances: number;
}

type Direction = 'record_entry' | 'adjust_balance';

interface GapFix {
  id: string; account_id: string; direction: Direction;
  observed_gap: string; reason: string; status: 'pending' | 'approved' | 'rejected';
  proposed_by: string; decided_by: string | null; decision_reason: string | null;
  applied_at: string | null; created_at: string; updated_at: string;
  account_name: string; proposed_by_username: string; decided_by_username: string | null;
  liveGap: number | null;
}

const DIRECTIONS: { key: Direction; title: string; belief: string }[] = [
  { key: 'record_entry', title: 'Record the missing entry', belief: 'the balance is right, the ledger is missing the entry that explains it' },
  { key: 'adjust_balance', title: 'Correct the balance', belief: 'the ledger is right, the account balance is wrong' },
];

const recorded = (f: GapFix) => parseFloat(String(f.observed_gap));
const drifted = (f: GapFix) => f.liveGap !== null && f.liveGap !== recorded(f);

export default function GapFixes() {
  const { user } = useAuth();
  const isAdmin = user?.roles?.includes('administrator') ?? false;

  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [proposals, setProposals] = useState<GapFix[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [busy, setBusy] = useState(false);

  const [proposing, setProposing] = useState<LedgerAccount | null>(null);
  const [direction, setDirection] = useState<Direction>('record_entry');
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState<GapFix | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const loadData = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const [audit, queue] = await Promise.allSettled([
        api.get<{ accounts: LedgerAccount[]; summary: AuditSummary }>('/corrections/audit'),
        api.get<{ data: GapFix[] }>('/corrections/gap-fixes'),
      ]);
      if (audit.status === 'fulfilled') {
        setAccounts(audit.value.accounts.filter((a) => !a.reconciled));
        setSummary(audit.value.summary);
      }
      if (queue.status === 'fulfilled') setProposals(queue.value.data);

      const failed = [audit, queue].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      setLoadError(failed.length > 0 ? failed[0].reason?.message || 'Could not load gap data' : '');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load gap data');
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => { loadData(); }, [loadData]);

  if (!isAdmin) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-10 text-center max-w-lg mx-auto">
        <ShieldAlert className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Administrator only</h2>
        <p className="text-sm text-gray-500">
          A gap fix rewrites an account balance or journals money into the ledger, so proposing and
          approving one is restricted to administrators — and never to the same person twice.
        </p>
      </div>
    );
  }

  const openPropose = (a: LedgerAccount) => {
    setProposing(a);
    setDirection('record_entry');
    setReason('');
  };

  const submitPropose = async () => {
    if (!proposing) return;
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await api.post('/corrections/gap-fixes', {
        accountId: proposing.id, direction, reason: reason.trim(),
      });
      setProposing(null);
      setTab('pending');
      await loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to propose a gap fix');
    } finally {
      setBusy(false);
    }
  };

  const approve = async (f: GapFix) => {
    const consequence = f.direction === 'record_entry'
      ? `a ${formatCurrency(Math.abs(recorded(f)))} ledger row will be appended to ${f.account_name} and its balance will not change`
      : `${f.account_name}'s balance will be set to what its ledger already implies, and no ledger row is written`;
    if (!window.confirm(
      `Apply this gap fix as the second administrator?\n\n${consequence}.\n\nThe account must reconcile afterwards or nothing is committed.`
    )) return;
    setBusy(true);
    try {
      await api.post(`/corrections/gap-fixes/${f.id}/approve`);
      await loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to apply the gap fix');
    } finally {
      setBusy(false);
    }
  };

  const submitReject = async () => {
    if (!rejecting) return;
    if (!rejectReason.trim()) return;
    setBusy(true);
    try {
      await api.post(`/corrections/gap-fixes/${rejecting.id}/reject`, { reason: rejectReason.trim() });
      setRejecting(null);
      setRejectReason('');
      await loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to reject the gap fix');
    } finally {
      setBusy(false);
    }
  };

  const byStatus = (s: GapFix['status']) => proposals.filter((p) => p.status === s);
  const pending = byStatus('pending');
  const decided = byStatus(tab === 'approved' ? 'approved' : 'rejected');
  const visible = tab === 'pending' ? pending : decided;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Ledger gap fixes</h3>
          <p className="text-sm text-gray-600">
            An account whose balance the ledger cannot explain. One administrator proposes, a different
            one approves, and the ledger is re-checked before anything is written.
          </p>
        </div>
        <div className="flex gap-3">
          <div className="bg-white border border-gray-200 rounded-lg px-4 py-2 text-center">
            <p className="text-xs text-gray-500">Open gaps</p>
            <p className={`text-lg font-semibold ${accounts.length > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {accounts.length}
            </p>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg px-4 py-2 text-center">
            <p className="text-xs text-gray-500">Awaiting approval</p>
            <p className="text-lg font-semibold text-amber-600">{pending.length}</p>
          </div>
          <button
            onClick={loadData}
            disabled={loading}
            className="self-center p-2 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
            title="Refresh"
            aria-label="Refresh gap data"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {loadError && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm flex items-start justify-between gap-4">
          <span>{loadError}</span>
          <button onClick={loadData} className="shrink-0 font-medium underline hover:no-underline">Retry</button>
        </div>
      )}

      <section className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-2">
          <Activity className="w-4 h-4 text-red-500" />
          <h4 className="text-sm font-semibold text-gray-900">Accounts that do not reconcile</h4>
          {summary && (
            <span className="text-xs text-gray-500">
              {summary.reconciled}/{summary.totalAccounts} reconciled · net gap {formatCurrency(summary.totalGap)}
            </span>
          )}
        </div>
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading the ledger audit…</div>
        ) : accounts.length === 0 ? (
          <div className="p-8 text-center">
            <Check className="w-8 h-8 text-green-400 mx-auto mb-2" />
            <p className="text-sm text-gray-500">Every account reconciles. Nothing to fix.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Account</th>
                  <th className="px-4 py-3 text-right font-medium">Ledger says</th>
                  <th className="px-4 py-3 text-right font-medium">Balance</th>
                  <th className="px-4 py-3 text-right font-medium">Gap</th>
                  <th className="px-4 py-3 text-left font-medium">What is wrong</th>
                  <th className="px-4 py-3 text-center font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {accounts.map((a) => (
                  <tr key={a.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{a.name}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{formatCurrency(a.expectedBalance)}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{formatCurrency(a.currentBalance)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${a.gap < 0 ? 'text-red-600' : 'text-amber-600'}`}>
                      {formatCurrency(a.gap)}
                    </td>
                    <td className="px-4 py-3 text-gray-500 max-w-[320px]">
                      <span className="block truncate" title={a.issues.join('; ') || undefined}>{a.issues.join('; ') || '—'}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => openPropose(a)}
                        disabled={a.gap === 0}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed"
                        title={a.gap === 0 ? 'This account has no balance gap to fix' : `Propose a fix for ${a.name}`}
                      >
                        <Plus className="w-3.5 h-3.5" /> Propose fix
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="flex gap-1 border-b border-gray-200 px-2">
          {(['pending', 'approved', 'rejected'] as const).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === key ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {key === 'pending' ? 'Awaiting approval' : key === 'approved' ? 'Applied' : 'Rejected'}
              <span className={`ml-2 px-1.5 py-0.5 rounded-full text-xs ${
                tab === key ? 'bg-primary-100 text-primary-700' : 'bg-gray-100 text-gray-500'
              }`}>
                {byStatus(key).length}
              </span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading proposals…</div>
        ) : visible.length === 0 ? (
          <div className="p-8 text-center">
            <Inbox className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500">
              {tab === 'pending' ? 'No gap fix is waiting for a decision.' : `No ${tab} gap fixes.`}
            </p>
          </div>
        ) : (
          <ProposalTable
            rows={visible}
            tab={tab}
            busy={busy}
            currentUserId={user?.id ?? ''}
            onApprove={approve}
            onReject={(f) => { setRejecting(f); setRejectReason(''); }}
          />
        )}
      </section>

      {proposing && (
        <ProposeModal
          account={proposing}
          direction={direction}
          onDirection={setDirection}
          reason={reason}
          onReason={setReason}
          busy={busy}
          onCancel={() => setProposing(null)}
          onSubmit={submitPropose}
        />
      )}

      {rejecting && (
        <RejectModal
          fix={rejecting}
          reason={rejectReason}
          onReason={setRejectReason}
          busy={busy}
          onCancel={() => { setRejecting(null); setRejectReason(''); }}
          onSubmit={submitReject}
        />
      )}
    </div>
  );
}

function ProposalTable({ rows, tab, busy, currentUserId, onApprove, onReject }: {
  rows: GapFix[]; tab: 'pending' | 'approved' | 'rejected'; busy: boolean;
  currentUserId: string; onApprove: (f: GapFix) => void; onReject: (f: GapFix) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            <th className="px-4 py-3 text-left font-medium">Account</th>
            <th className="px-4 py-3 text-left font-medium">Fix</th>
            <th className="px-4 py-3 text-right font-medium">Gap when proposed</th>
            <th className="px-4 py-3 text-right font-medium">Gap now</th>
            <th className="px-4 py-3 text-left font-medium">Reason</th>
            <th className="px-4 py-3 text-left font-medium">Proposed by</th>
            {tab !== 'pending' && <th className="px-4 py-3 text-left font-medium">Decided by</th>}
            <th className="px-4 py-3 text-left font-medium">Proposed</th>
            {tab === 'pending' && <th className="px-4 py-3 text-center font-medium">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((f) => {
            const isMine = f.proposed_by === currentUserId;
            const moved = drifted(f);
            return (
              <tr key={f.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{f.account_name}</td>
                <td className="px-4 py-3">
                  <span className={`badge-${f.direction === 'record_entry' ? 'blue' : 'yellow'}`}>
                    {f.direction === 'record_entry' ? 'Journal entry' : 'Balance'}
                  </span>
                  <span className="block text-xs text-gray-500 mt-0.5">
                    {f.direction === 'record_entry' ? 'balance unchanged' : 'no ledger row'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-gray-700">{formatCurrency(recorded(f))}</td>
                <td className="px-4 py-3 text-right">
                  {f.liveGap === null ? <span className="text-gray-400">—</span> : (
                    <span className={moved ? 'inline-flex items-center gap-1 font-semibold text-red-600' : 'text-gray-700'}>
                      {moved && <AlertTriangle className="w-3.5 h-3.5" aria-label="The gap changed after this was proposed" />}
                      {formatCurrency(f.liveGap)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-500 max-w-[240px]">
                  <span className="block truncate" title={f.reason}>{f.reason}</span>
                  {tab !== 'pending' && f.decision_reason && (
                    <span className="block truncate text-xs text-red-600" title={f.decision_reason}>{f.decision_reason}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-700">{f.proposed_by_username}</td>
                {tab !== 'pending' && <td className="px-4 py-3 text-gray-700">{f.decided_by_username || '—'}</td>}
                <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{manilaDateTimeLabel(f.created_at)}</td>
                {tab === 'pending' && (
                  <td className="px-4 py-3 text-center">
                    {isMine ? (
                      <span className="text-xs text-gray-400 whitespace-nowrap" title="You proposed this — a different administrator must decide">
                        You proposed this
                      </span>
                    ) : (
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => onApprove(f)}
                          disabled={busy}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          <Check className="w-3.5 h-3.5" /> Approve
                        </button>
                        <button
                          onClick={() => onReject(f)}
                          disabled={busy}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 disabled:opacity-50"
                        >
                          <X className="w-3.5 h-3.5" /> Reject
                        </button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProposeModal({ account, direction, onDirection, reason, onReason, busy, onCancel, onSubmit }: {
  account: LedgerAccount; direction: Direction; onDirection: (d: Direction) => void;
  reason: string; onReason: (r: string) => void; busy: boolean;
  onCancel: () => void; onSubmit: () => void;
}) {
  const journalBalance = account.currentBalance;
  const correctedBalance = account.expectedBalance;
  const chosen = direction === 'record_entry' ? journalBalance : correctedBalance;
  const delta = chosen - account.currentBalance;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="propose-title">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 id="propose-title" className="text-lg font-semibold text-gray-900">Propose a gap fix — {account.name}</h2>
          <p className="text-xs text-gray-500 mt-1">
            Ledger says {formatCurrency(account.expectedBalance)} · balance is {formatCurrency(account.currentBalance)} ·
            gap {formatCurrency(account.gap)}
          </p>
        </div>

        <div className="px-6 py-4 space-y-5">
          {account.issues.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2 text-xs">
              {account.issues.join(' · ')}
            </div>
          )}

          <fieldset>
            <legend className="block text-sm font-medium text-gray-700 mb-2">Which side is wrong?</legend>
            <div className="grid sm:grid-cols-2 gap-3">
              {DIRECTIONS.map((d) => {
                const selected = direction === d.key;
                const balanceAfter = d.key === 'record_entry' ? journalBalance : correctedBalance;
                return (
                  <label
                    key={d.key}
                    className={`block rounded-lg border p-3 cursor-pointer transition-colors ${
                      selected ? 'border-primary-600 ring-2 ring-primary-100 bg-primary-50' : 'border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="gap-direction"
                      value={d.key}
                      checked={selected}
                      onChange={() => onDirection(d.key)}
                      className="sr-only"
                    />
                    <span className="flex items-center gap-2">
                      <span className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${selected ? 'border-primary-600 bg-primary-600' : 'border-gray-300'}`} />
                      <span className="text-sm font-semibold text-gray-900">{d.title}</span>
                    </span>
                    <span className="block text-xs text-gray-600 mt-1.5">{d.belief}</span>
                    <span className="block text-xs font-medium text-gray-900 mt-2">
                      Balance {formatCurrency(account.currentBalance)} → {formatCurrency(balanceAfter)}
                    </span>
                    <span className="block text-xs text-gray-500">
                      {d.key === 'record_entry'
                        ? `adds a ${formatCurrency(Math.abs(account.gap))} ledger row`
                        : 'no ledger row is written'}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {direction === 'adjust_balance' && delta !== 0 && (
            <div className={`rounded-lg border px-3 py-2 text-sm flex items-start gap-2 ${
              delta < 0 ? 'bg-red-50 border-red-200 text-red-800' : 'bg-amber-50 border-amber-200 text-amber-800'
            }`}>
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                This changes the account balance by {formatCurrency(delta)} — from{' '}
                {formatCurrency(account.currentBalance)} to {formatCurrency(chosen)}.
                {delta < 0 && ' Money leaves this account.'}
              </span>
            </div>
          )}

          <div>
            <label htmlFor="propose-reason" className="block text-sm font-medium text-gray-700 mb-1">
              Why is this the right side? (required)
            </label>
            <textarea
              id="propose-reason"
              value={reason}
              onChange={(e) => onReason(e.target.value)}
              rows={3}
              autoFocus
              placeholder="e.g. Balance was imported from the legacy system and never journaled; owner confirmed the figure on 2026-09-30."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              A different administrator approves this. Nothing is written until they do, and the account
              must reconcile afterwards or the whole change rolls back.
            </p>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={busy || !reason.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {busy ? 'Submitting…' : 'Propose fix'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RejectModal({ fix, reason, onReason, busy, onCancel, onSubmit }: {
  fix: GapFix; reason: string; onReason: (r: string) => void; busy: boolean;
  onCancel: () => void; onSubmit: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md" role="dialog" aria-modal="true" aria-labelledby="reject-title">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
          <X className="w-5 h-5 text-red-500" />
          <h2 id="reject-title" className="text-lg font-semibold text-gray-900">Reject gap fix</h2>
        </div>
        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-gray-600">
            <strong>{fix.account_name}</strong>, gap {formatCurrency(recorded(fix))}. Nothing will be
            written — the account stays out of balance until someone proposes a fix you accept.
          </p>
          <div>
            <label htmlFor="gap-reject-reason" className="block text-sm font-medium text-gray-700 mb-1">Reason (required)</label>
            <textarea
              id="gap-reject-reason"
              value={reason}
              onChange={(e) => onReason(e.target.value)}
              rows={3}
              autoFocus
              placeholder="e.g. Source of these funds not confirmed yet — check with the owner first."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={busy || !reason.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      </div>
    </div>
  );
}
