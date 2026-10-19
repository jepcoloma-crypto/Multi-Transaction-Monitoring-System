import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { formatCurrency, manilaDateTimeLabel } from '../lib/format';
import {
  directionLabel,
  fixerFor,
  totalFindings,
  firstDisagreeing,
  type IntegrityReport,
} from '../lib/integrity';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';

// Integrity checks (design IC1–IC6).
//
// This page reads two halves of the books that do not derive from each other and
// reports whether they agree: what the income report claims the till earned
// against what the till's own rows carry, where a fee's row sits against where
// its tender says, and what a record claims against the ledger it wrote.
//
// It writes nothing, and deliberately so. A finding says two numbers differ — it
// cannot say which one is wrong, and today's ₱20 needed a policy decision (D46)
// before anybody could know. So where a known correction path applies the finding
// points at the tool that already owns it, and an administrator confirms the
// correction there with a reason and a preview. Where none applies, the finding
// offers nothing. A tool that guessed would have moved the money the wrong way
// with identical-looking output (IC2).
//
// The auditor sees every finding and cannot move a peso; the tools that can are
// unchanged and still administrator-gated (IC3).

const money = (value: number | null | undefined): string =>
  formatCurrency(Number.isFinite(Number(value)) ? Number(value ?? 0) : 0);

const STATUS_META = {
  pass: {
    label: 'In agreement',
    badge: 'bg-green-100 text-green-800',
    icon: CheckCircle2,
    iconClass: 'text-green-600',
  },
  findings: {
    label: 'Disagrees',
    badge: 'bg-red-100 text-red-800',
    icon: AlertTriangle,
    iconClass: 'text-red-600',
  },
} as const;

export default function Integrity() {
  const { user } = useAuth();
  const isAdmin = user?.roles?.includes('administrator') ?? false;
  const isAuditor = user?.roles?.includes('auditor') ?? false;

  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<IntegrityReport>('/integrity/run');
      setReport(data);
      // Open the first check that disagrees — the reader came for the finding.
      setOpen(firstDisagreeing(data));
    } catch (err) {
      console.error('Integrity run error:', err);
      setError(err instanceof Error ? err.message : 'The checks could not be run.');
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  if (!isAdmin && !isAuditor) {
    return (
      <div className="p-6">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-amber-600 mt-0.5" />
          <div>
            <p className="font-medium text-amber-900">Auditor access required</p>
            <p className="text-sm text-amber-800">
              These checks read the whole ledger to compare the books against themselves. They are
              limited to auditors and administrators.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const findings = report ? totalFindings(report) : 0;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Integrity Checks</h1>
        <p className="text-sm text-gray-600 mt-1">
          Do the books' two halves agree? These compare surfaces that do not derive from one
          another — what the income report claims the till earned against what the till's rows
          carry, where a fee's row sits against where its tender says, and what each record claims
          against the ledger it wrote. Run them on demand; they take no locks and write nothing.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Read-only · findings name a disagreement, not a cause · corrections stay with an
          administrator in the tool that already owns them.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={run}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
        >
          {report ? <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> : <PlayCircle className="w-4 h-4" />}
          {loading ? 'Running…' : report ? 'Run again' : 'Run checks'}
        </button>
        {report && (
          <p className="text-xs text-gray-500">
            {report.movements} movement(s) read · ran {manilaDateTimeLabel(report.ranAt)}
          </p>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {report && report.clean && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5" />
          <div>
            <p className="font-medium text-green-900">The books agree</p>
            <p className="text-sm text-green-800">
              All {report.checks.length} checks held on {report.movements} movement(s). Nothing to
              investigate.
            </p>
          </div>
        </div>
      )}

      {report && !report.clean && (
        <p className="text-sm font-medium text-red-700">
          {findings} disagreement{findings === 1 ? '' : 's'} found.
        </p>
      )}

      {report?.checks.map((check) => {
        const meta = STATUS_META[check.status];
        const Icon = meta.icon;
        const fixer = fixerFor(check.id);
        const isOpen = open === check.id;
        return (
          <section key={check.id} className="bg-white rounded-lg border">
            <button
              onClick={() => setOpen(isOpen ? null : check.id)}
              className="w-full text-left px-4 py-3 flex items-start gap-3"
            >
              <Icon className={`w-5 h-5 mt-0.5 shrink-0 ${meta.iconClass}`} />
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold text-gray-900">{check.title}</h2>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${meta.badge}`}>
                    {meta.label}
                  </span>
                  <span className="text-xs text-gray-500">{check.checked} checked</span>
                </div>
                <p className="text-sm text-gray-600 mt-1">{check.summary}</p>
                <p className="text-xs text-gray-400 mt-1">{check.states}</p>
              </div>
              <Eye className="w-4 h-4 text-gray-400 mt-1 shrink-0" />
            </button>

            {isOpen && check.findings.length > 0 && (
              <div className="border-t">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500">
                      <tr>
                        <th className="px-4 py-2">Record</th>
                        <th className="px-4 py-2">Reference</th>
                        <th className="px-4 py-2 text-right">Expected</th>
                        <th className="px-4 py-2 text-right">Held</th>
                        <th className="px-4 py-2">Why it matters</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {check.findings.map((f, i) => (
                        <tr key={`${check.id}-${f.transactionNumber ?? i}`} className="align-top">
                          <td className="px-4 py-3">
                            <p className="font-medium text-gray-900">
                              {f.transactionNumber ?? 'Movement'}
                            </p>
                            <p className="text-xs text-gray-500">
                              {directionLabel(f.direction)}
                              {f.amount != null && ` · ${money(f.amount)}`}
                              {f.fee != null && Number(f.fee) > 0 && ` · fee ${money(f.fee)}`}
                            </p>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-gray-700 whitespace-nowrap">
                            {f.referenceNumber || '-'}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">{money(f.expected)}</td>
                          <td className="px-4 py-3 text-right tabular-nums">{money(f.actual)}</td>
                          <td className="px-4 py-3 text-gray-700">{f.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {fixer && (
                  <div className="px-4 py-3 bg-gray-50 border-t flex flex-wrap items-center gap-3">
                    <p className="text-xs text-gray-600 flex-1 min-w-64">
                      <span className="font-medium text-gray-900">Next step.</span> {fixer.hint}{' '}
                      {isAdmin
                        ? 'Review the planned rows before applying — nothing already posted is rewritten.'
                        : 'This page never corrects anything: an administrator applies the fix in the tool below.'}
                    </p>
                    {isAdmin ? (
                      <Link
                        to={fixer.href}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-600 text-white hover:bg-primary-700"
                      >
                        Open {fixer.label}
                      </Link>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-gray-300 text-gray-600">
                        {fixer.label} · administrator only
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}

      {!report && !error && (
        <div className="bg-white rounded-lg border p-8 text-center text-gray-500">
          <PlayCircle className="w-6 h-6 mx-auto mb-2 text-gray-300" />
          <p className="text-sm">Run the checks to read the books against themselves.</p>
          <p className="text-xs text-gray-400 mt-1">
            On demand only — there is no schedule, and nothing here is written.
          </p>
        </div>
      )}
    </div>
  );
}
