import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { formatCurrency, manilaDateTimeLabel } from '../lib/format';
import { roleLabel, sideLabel, isUnlabelled, type MovementHistory } from '../lib/movementHistory';
import { AlertTriangle, History, Loader2, ScrollText, UserRound } from 'lucide-react';

// What happened to one movement, and who did it.
//
// Read-only, and gated on the same permission the Integrity page holds: reading
// a history is the auditor's job, moving money is not. Every path that corrects
// a movement stays where it was, administrator-gated, and none of them is
// reachable from here — a reader of this page can see that a fee was re-posted
// and by whom, but cannot re-post one.
//
// The rows are labelled by `role` rather than by matching a description. An
// unlabelled row is shown as unlabelled instead of being folded into a bucket,
// because a row nobody has labelled is a gap worth seeing rather than a row
// worth assuming about.

export default function MovementHistory() {
  const { id } = useParams<{ id: string }>();
  const [history, setHistory] = useState<MovementHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setHistory(await api.get<MovementHistory>(`/movements/${id}/history`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this movement');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
      </div>
    );
  }

  if (error || !history) {
    return (
      <div className="m-8 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <AlertTriangle className="mb-1 h-4 w-4" />
        {error ?? 'This movement could not be found.'}
      </div>
    );
  }

  const { transaction: tx, rows, trail } = history;

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
          <History className="h-5 w-5" /> Movement #{tx.transactionNumber}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {tx.typeName ?? 'Movement'} · {tx.accountName ?? 'Unknown account'} ·{' '}
          {manilaDateTimeLabel(tx.transactionDate)}
        </p>
      </header>

      <div className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Field label="Amount" value={formatCurrency(tx.amount)} />
        <Field label="Fee" value={formatCurrency(tx.fee)} />
        <Field label="Net" value={formatCurrency(tx.netAmount)} />
        <Field label="Fee collected" value={tx.feeAddedToBalance ? 'On top' : 'From amount'} />
        <Field label="Status" value={tx.status} />
        <Field label="Reference" value={tx.referenceNumber ?? '—'} />
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">
          Ledger rows <span className="font-normal text-slate-400">({rows.length})</span>
        </h2>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Leg</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-right">Balance after</th>
                <th className="px-3 py-2">Written</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className={isUnlabelled(r.role) ? 'bg-amber-50' : undefined}>
                  <td className="px-3 py-2 font-medium text-slate-700">{sideLabel(r.entryType)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        isUnlabelled(r.role)
                          ? 'text-amber-700'
                          : r.role === 'correction' || r.role === 'reversal'
                            ? 'text-indigo-700'
                            : 'text-slate-600'
                      }
                    >
                      {roleLabel(r.role)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{r.accountName ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(r.amount)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                    {formatCurrency(r.balanceAfter)}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400">
                    {manilaDateTimeLabel(r.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          Rows appear in the order they were written — the order the statement's running balance
          reads. Correction and reversal rows are additions to the original, never replacements of
          it.
        </p>
      </section>

      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
          <ScrollText className="h-4 w-4" /> Audit trail{' '}
          <span className="font-normal text-slate-400">({trail.length})</span>
        </h2>
        {trail.length === 0 ? (
          <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">
            No audit entries for this movement.
          </p>
        ) : (
          <ol className="space-y-2">
            {trail.map((e) => (
              <li key={e.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-slate-800">{e.action}</span>
                  <span className="text-xs text-slate-400">{manilaDateTimeLabel(e.createdAt)}</span>
                </div>
                <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                  <UserRound className="h-3 w-3" /> {e.username ?? 'Unknown'}
                </div>
                {e.reason && <p className="mt-2 text-sm text-slate-600">Reason: {e.reason}</p>}
                {e.changed.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs text-slate-500">
                    {e.changed.map((c) => (
                      <li key={c.column} className="tabular-nums">
                        <span className="font-medium text-slate-600">{c.column}</span>:{' '}
                        {JSON.stringify(c.from ?? null)} → {JSON.stringify(c.to ?? null)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
        {!history.touched && (
          <p className="mt-2 text-xs text-slate-400">
            Written once and never since corrected.
          </p>
        )}
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase text-slate-400">{label}</div>
      <div className="text-sm font-medium text-slate-800 tabular-nums">{value}</div>
    </div>
  );
}
