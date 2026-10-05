import { useState, useEffect, useCallback, Fragment } from 'react';
import { api, unwrapRows } from '../lib/api';
import { formatCurrency, localDateValue } from '../lib/format';
import { useAuth } from '../contexts/AuthContext';
import AccountSelect, { type AccountOption } from '../components/AccountSelect';
import {
  Wallet, Plus, Check, X, ChevronRight, RefreshCw, ShieldAlert, AlertTriangle, Inbox,
} from 'lucide-react';

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

interface Statement {
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

interface PendingExpense {
  id: string;
  transaction_number: number;
  amount: string;
  status: string;
  transaction_date: string;
  description: string | null;
  notes: string | null;
  reference_number: string | null;
  payee: string | null;
  created_at: string;
  rejection_reason: string | null;
  category_name: string | null;
  account_name: string;
  current_balance: string;
  branch_code: string;
  branch_name: string;
  requested_by_username: string | null;
}

interface Category {
  id: string;
  name: string;
}

interface TypeRow {
  id: string;
  code: string;
}

const emptyForm = {
  accountId: '',
  transactionCategoryId: '',
  amount: '',
  payee: '',
  description: '',
  referenceNumber: '',
  transactionDate: localDateValue(),
  paymentMethod: 'cash',
};

export default function CashManagement() {
  const { user } = useAuth();
  const isAdmin = user?.roles?.includes('administrator') ?? false;
  const isApprover = isAdmin || user?.roles?.includes('manager');
  const canWrite = true;

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [branchId, setBranchId] = useState('');

  const [statement, setStatement] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [drill, setDrill] = useState<Drill | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

  const [expenses, setExpenses] = useState<PendingExpense[]>([]);
  const [loadingExpenses, setLoadingExpenses] = useState(false);

  const [branches, setBranches] = useState<{ id: string; code: string; name: string }[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [expenseTypeId, setExpenseTypeId] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadStatement = useCallback(async () => {
    setLoading(true);
    setDrill(null);
    try {
      const params = new URLSearchParams();
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      if (branchId) params.set('branchId', branchId);
      const qs = params.toString();
      const result = await api.get<Statement>(`/cash-management/statement${qs ? `?${qs}` : ''}`);
      setStatement(result);
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the cash statement');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, branchId]);

  const loadExpenses = useCallback(async () => {
    if (!isApprover) return;
    setLoadingExpenses(true);
    try {
      const value = await api.get<{ data: PendingExpense[] } | PendingExpense[]>('/cash-management/expenses/pending?status=pending');
      setExpenses(unwrapRows<PendingExpense>(value));
    } catch {
      setExpenses([]);
    } finally {
      setLoadingExpenses(false);
    }
  }, [isApprover]);

  const loadSetup = useCallback(async () => {
    try {
      const [branchVal, accountVal, typeVal, categoryVal] = await Promise.allSettled([
        api.get<{ id: string; code: string; name: string }[]>('/branches'),
        api.get<AccountOption[]>('/accounts'),
        api.get<TypeRow[]>('/transaction-types/types'),
        api.get<Category[]>('/transaction-types/categories'),
      ]);
      if (branchVal.status === 'fulfilled') setBranches(unwrapRows(branchVal.value));
      if (accountVal.status === 'fulfilled') setAccounts(unwrapRows(accountVal.value));
      if (typeVal.status === 'fulfilled') {
        const opex = unwrapRows<TypeRow>(typeVal.value).find((t) => t.code === 'operating_expense');
        setExpenseTypeId(opex?.id || '');
      }
      if (categoryVal.status === 'fulfilled') setCategories(unwrapRows(categoryVal.value));
    } catch {
      // Setup is advisory: the form reports a missing type when submitted.
    }
  }, []);

  useEffect(() => { loadSetup(); }, [loadSetup]);
  useEffect(() => { loadStatement(); }, [loadStatement]);
  useEffect(() => { loadExpenses(); }, [loadExpenses]);

  const openDrill = async (line: BucketLine, direction: 'credit' | 'debit') => {
    setDrillLoading(true);
    try {
      const params = new URLSearchParams({ bucket: line.bucket, direction });
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      if (branchId) params.set('branchId', branchId);
      const result = await api.get<Drill>(`/cash-management/statement/drill?${params.toString()}`);
      setDrill(result);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not load the rows behind this figure');
    } finally {
      setDrillLoading(false);
    }
  };

  const openForm = () => {
    setForm({ ...emptyForm, transactionDate: localDateValue() });
    setFormError('');
    // The revolving fund is where cash-on-hand expenses belong, so it is
    // preselected rather than made the operator hunt for it among the wallets.
    // Prefer this user's own branch's float: the list holds every branch's
    // wallet, and preselecting someone else's cash would be an easy mistake to
    // approve.
    const ownBranches = (user?.branches || []).map((b) => b.name);
    const float =
      accounts.find((a) => a.name === 'Revolving Fund' && !!a.branch_name && ownBranches.includes(a.branch_name))
      || accounts.find((a) => a.name === 'Revolving Fund');
    if (float) setForm((f) => ({ ...f, accountId: float.id }));
    setShowForm(true);
  };

  const submitExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!expenseTypeId) {
      setFormError('The operating expense type is not available on this server.');
      return;
    }
    if (!form.accountId) { setFormError('Choose the wallet the money is paid from.'); return; }
    if (!form.amount || Number(form.amount) <= 0) { setFormError('Enter an amount greater than zero.'); return; }
    if (!form.description.trim()) { setFormError('Describe what the money was spent on.'); return; }

    setSaving(true);
    try {
      await api.post('/transactions', {
        accountId: form.accountId,
        transactionTypeId: expenseTypeId,
        transactionCategoryId: form.transactionCategoryId || null,
        amount: Number(form.amount),
        description: form.description.trim(),
        payee: form.payee.trim() || null,
        referenceNumber: form.referenceNumber.trim() || null,
        transactionDate: form.transactionDate,
        paymentMethod: form.paymentMethod || null,
      });
      setShowForm(false);
      await Promise.all([loadStatement(), loadExpenses()]);
      window.dispatchEvent(new Event('approvals-changed'));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not record the expense');
    } finally {
      setSaving(false);
    }
  };

  const decide = async (expense: PendingExpense, action: 'approve' | 'reject') => {
    const verb = action === 'approve' ? 'Approve' : 'Reject';
    if (action === 'approve') {
      const ok = window.confirm(
        `Approve ${formatCurrency(Number(expense.amount))} — this will be deducted from ${expense.account_name} now?`
      );
      if (!ok) return;
    } else {
      const reason = window.prompt('Reason for rejecting this expense:');
      if (reason === null) return;
      if (!reason.trim()) { alert('A reason is required.'); return; }
      try {
        await api.post(`/transactions/${expense.id}/reject`, { reason: reason.trim() });
        await Promise.all([loadStatement(), loadExpenses()]);
        window.dispatchEvent(new Event('approvals-changed'));
        return;
      } catch (err) {
        alert(err instanceof Error ? err.message : `${verb} failed`);
        return;
      }
    }

    setBusy(true);
    try {
      await api.post(`/transactions/${expense.id}/approve`);
      await Promise.all([loadStatement(), loadExpenses()]);
      window.dispatchEvent(new Event('approvals-changed'));
    } catch (err) {
      alert(err instanceof Error ? err.message : `${verb} failed`);
    } finally {
      setBusy(false);
    }
  };

  if (!user) {
    return (
      <div className="p-6">
        <div className="bg-white rounded-lg border border-gray-200 p-10 text-center max-w-lg mx-auto">
          <ShieldAlert className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Sign in required</h2>
          <p className="text-sm text-gray-500">Your session ended. Sign in again to view the cash position.</p>
        </div>
      </div>
    );
  }

  const t = statement?.totals;
  const cardGrid = 'grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 text-sm';

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Wallet className="w-6 h-6 text-primary-600" />
            Cash Management
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Where the company's cash physically is, and how it moved.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={loadStatement} className="btn-secondary" disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          {canWrite && (
            <button type="button" onClick={openForm} className="btn-primary">
              <Plus className="w-4 h-4" />
              Record expense
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="form-label">From</label>
            <input
              type="date"
              className="form-input"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div>
            <label className="form-label">To</label>
            <input
              type="date"
              className="form-input"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <div>
            <label className="form-label">Branch</label>
            <select className="form-input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">All branches I can see</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <p className="text-xs text-gray-500">
              Leave both dates empty to cover all recorded history.
            </p>
          </div>
        </div>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-4">{loadError}</div>
      )}

      {loading ? (
        <div className="card text-center py-10 text-sm text-gray-500">Loading cash position…</div>
      ) : statement && t ? (
        <>
          <div className={cardGrid}>
            <div className="card">
              <p className="text-gray-500">Cash on hand now</p>
              <p className="text-2xl font-bold mt-1">{formatCurrency(t.current)}</p>
              <p className="text-sm text-gray-500">Every account balance, totalled</p>
            </div>
            <div className="card">
              <p className="text-gray-500">Opening</p>
              <p className="text-2xl font-bold mt-1">{formatCurrency(t.opening)}</p>
              <p className="text-sm text-gray-500">Balances at the start of this period</p>
            </div>
            <div className="card">
              <p className="text-gray-500">Sources</p>
              <p className="text-2xl font-bold mt-1 text-emerald-600">{formatCurrency(t.sources)}</p>
              <p className="text-sm text-gray-500">Money that came in</p>
            </div>
            <div className="card">
              <p className="text-gray-500">Uses</p>
              <p className="text-2xl font-bold mt-1 text-red-600">{formatCurrency(t.uses)}</p>
              <p className="text-sm text-gray-500">Money that went out</p>
            </div>
            <div className="card">
              <p className="text-gray-500">Closing</p>
              <p className="text-2xl font-bold mt-1">{formatCurrency(t.closing)}</p>
              <p className={`text-sm ${t.balanced ? 'text-emerald-600' : 'text-amber-600'}`}>
                {t.balanced
                  ? 'Ties to the balances exactly'
                  : `Off by ${formatCurrency(t.difference)} — this period ends before today`}
              </p>
            </div>
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
                          {!tied && <span className="ml-1.5 text-xs" title="The period ends before today, so closing and the live balance are different figures by design.">·</span>}
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
                    <tr><td className="px-4 py-6 text-center text-sm text-gray-500">No inflows in this period.</td></tr>
                  ) : statement.sources.map((line) => (
                    <tr key={line.bucket} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm">
                        <button
                          type="button"
                          onClick={() => openDrill(line, 'credit')}
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
                    <tr><td className="px-4 py-6 text-center text-sm text-gray-500">No outflows in this period.</td></tr>
                  ) : statement.uses.map((line) => (
                    <tr key={line.bucket} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm">
                        <button
                          type="button"
                          onClick={() => openDrill(line, 'debit')}
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
                      <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500">No rows in this period.</td></tr>
                    ) : drill.rows.map((row) => (
                      <tr key={row.id}>
                        <td className="px-4 py-3 text-sm whitespace-nowrap">
                          {row.entry_date ? new Date(row.entry_date).toLocaleDateString() : '—'}
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
        </>
      ) : null}

      {isApprover && (
        <div className="card overflow-hidden">
          <div className="px-4 pt-4 pb-1">
            <h4 className="font-medium">Awaiting approval</h4>
            <p className="text-xs text-gray-500">
              A second person releases these. Nobody approves their own request, and only an
              administrator may release or decline an operating expense.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Txn #</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Account</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Paid to</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Description</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Amount</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {loadingExpenses ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-gray-500">Loading…</td></tr>
                ) : expenses.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center">
                      <Inbox className="w-6 h-6 text-gray-300 mx-auto mb-2" />
                      <p className="text-sm text-gray-500">Nothing is waiting for a decision.</p>
                    </td>
                  </tr>
                ) : expenses.map((exp) => (
                  <Fragment key={exp.id}>
                    <tr className="hover:bg-gray-50">
                      <td className="px-4 py-3.5 text-sm font-mono text-xs font-medium whitespace-nowrap">TXN #{exp.transaction_number}</td>
                      <td className="px-4 py-3.5 text-sm whitespace-nowrap">
                        {exp.transaction_date ? new Date(exp.transaction_date).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-3.5 text-sm whitespace-nowrap">
                        {exp.account_name}
                        <span className="text-gray-400"> · {exp.branch_name}</span>
                      </td>
                      <td className="px-4 py-3.5 text-sm text-gray-600 whitespace-nowrap">{exp.category_name || '—'}</td>
                      <td className="px-4 py-3.5 text-sm text-gray-600 whitespace-nowrap">{exp.payee || '—'}</td>
                      <td className="px-4 py-3.5 text-sm text-gray-600 max-w-[260px] truncate" title={exp.description || ''}>
                        {exp.description || '—'}
                      </td>
                      <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold text-red-600">
                        {formatCurrency(Number(exp.amount))}
                      </td>
                      <td className="px-4 py-3.5 text-sm text-right whitespace-nowrap">
                        {isAdmin ? (
                          <div className="inline-flex gap-2">
                            <button
                              type="button"
                              className="btn-primary"
                              disabled={busy}
                              onClick={() => decide(exp, 'approve')}
                            >
                              <Check className="w-4 h-4" /> Approve
                            </button>
                            <button
                              type="button"
                              className="btn-secondary"
                              disabled={busy}
                              onClick={() => decide(exp, 'reject')}
                            >
                              <X className="w-4 h-4" /> Reject
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">Administrator decides</span>
                        )}
                      </td>
                    </tr>
                    <tr className="bg-gray-50 detail-row">
                      <td colSpan={8} className="px-4 py-2 text-xs text-gray-500">
                        Requested by <strong>{exp.requested_by_username || '—'}</strong> on{' '}
                        {new Date(exp.created_at).toLocaleString()}
                        {exp.reference_number && <> · voucher <span className="font-mono">{exp.reference_number}</span></>}
                        {' '}· balance before decision {formatCurrency(Number(exp.current_balance))}
                        <span className="ml-2 inline-flex items-center gap-1 text-gray-400">
                          <AlertTriangle className="w-3 h-3" />
                          approving moves this from {exp.branch_name}'s wallet
                        </span>
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4">
          <div className="mx-auto mt-12 max-w-xl bg-white rounded-xl shadow-xl border border-gray-200">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold">Record operating expense</h3>
              <button type="button" onClick={() => setShowForm(false)} aria-label="Close" className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={submitExpense} className="p-5 space-y-4">
              <div className="bg-blue-50 border border-blue-200 text-blue-800 text-xs rounded-lg p-3">
                This is saved as a request, not a withdrawal. Nothing leaves the wallet until a second
                person approves it.
              </div>

              <div>
                <label className="form-label">Wallet to pay from</label>
                <AccountSelect
                  accounts={accounts}
                  value={form.accountId}
                  onChange={(v) => setForm((f) => ({ ...f, accountId: v }))}
                  placeholder="Select the wallet the cash comes out of"
                  className="w-full"
                />
                <p className="text-xs text-gray-500 mt-1">
                  The revolving fund holds the branch's physical cash on hand. Any visible wallet may be used.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Category</label>
                  <select
                    className="form-input"
                    value={form.transactionCategoryId}
                    onChange={(e) => setForm((f) => ({ ...f, transactionCategoryId: e.target.value }))}
                  >
                    <option value="">Uncategorised</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="form-label">Amount (PHP)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    className="form-input"
                    value={form.amount}
                    onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                    placeholder="0.00"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Paid to</label>
                  <input
                    type="text"
                    className="form-input"
                    value={form.payee}
                    onChange={(e) => setForm((f) => ({ ...f, payee: e.target.value }))}
                    placeholder="Who received the money"
                  />
                </div>
                <div>
                  <label className="form-label">Voucher / reference</label>
                  <input
                    type="text"
                    className="form-input"
                    value={form.referenceNumber}
                    onChange={(e) => setForm((f) => ({ ...f, referenceNumber: e.target.value }))}
                    placeholder="Optional"
                  />
                </div>
              </div>

              <div>
                <label className="form-label">What was it for</label>
                <input
                  type="text"
                  className="form-input"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Electrical bill — October"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Date paid</label>
                  <input
                    type="date"
                    className="form-input"
                    value={form.transactionDate}
                    onChange={(e) => setForm((f) => ({ ...f, transactionDate: e.target.value }))}
                    required
                  />
                </div>
                <div>
                  <label className="form-label">How it was paid</label>
                  <select
                    className="form-input"
                    value={form.paymentMethod}
                    onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))}
                  >
                    <option value="cash">Cash</option>
                    <option value="gcash">GCash</option>
                    <option value="bank">Bank Transfer</option>
                    <option value="maya">Maya</option>
                  </select>
                </div>
              </div>

              {formError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">{formError}</div>
              )}

              <div className="flex justify-end gap-3 pt-1">
                <button type="button" className="btn-secondary" onClick={() => setShowForm(false)} disabled={saving}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={saving}>
                  {saving ? 'Saving…' : 'Send for approval'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
