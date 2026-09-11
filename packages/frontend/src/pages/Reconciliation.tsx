import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { Scale, Plus, Check, Eye, X, Filter, Upload, ArrowRight, RefreshCw, Trash2 } from 'lucide-react';
import Pagination from '../components/Pagination';

interface Reconciliation {
  id: string; account_name: string; expected_balance: number; actual_balance: number;
  variance: number; status: string; notes: string; reconciled_by_email: string;
  reconciled_at: string; created_at: string;
}

interface StatementEntry {
  id: string; account_id: string; statement_date: string; description: string;
  reference_number: string; debit: number; credit: number; balance: number;
  is_matched: boolean; created_at: string;
}

interface UnmatchedTxn {
  id: string; transaction_number: number; amount: number; transaction_date: string;
  type_name: string; direction: string; description: string; reference_number: string;
}

interface MatchRecord {
  id: string; statement_id: string; transaction_id: string; match_type: string;
  matched_at: string; statement_date: string; stmt_desc: string;
  stmt_debit: number; stmt_credit: number; stmt_ref: string;
  transaction_number: number; txn_amount: number; txn_date: string;
  type_name: string; direction: string;
}

interface Account { id: string; name: string; current_balance: number; }

type TabType = 'reconciliation' | 'bank-reconciliation';

export default function Reconciliation() {
  const [tab, setTab] = useState<TabType>('reconciliation');
  const [recons, setRecons] = useState<Reconciliation[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showDetail, setShowDetail] = useState<Reconciliation | null>(null);
  const [filter, setFilter] = useState('');
  const [form, setForm] = useState({ accountId: '', actualBalance: '', notes: '' });
  const [adjustForm, setAdjustForm] = useState({ adjustmentAmount: '', reason: '' });
  const [submitting, setSubmitting] = useState(false);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });

  // Bank reconciliation state
  const [bankAccountId, setBankAccountId] = useState('');
  const [statements, setStatements] = useState<StatementEntry[]>([]);
  const [unmatchedTxns, setUnmatchedTxns] = useState<UnmatchedTxn[]>([]);
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [bankLoading, setBankLoading] = useState(false);
  const [autoMatching, setAutoMatching] = useState(false);
  const [selectedStmt, setSelectedStmt] = useState<string | null>(null);
  const [selectedTxn, setSelectedTxn] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState('');
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualForm, setManualForm] = useState({ date: '', description: '', referenceNumber: '', debit: '', credit: '', balance: '' });

  const loadRecons = async (page = 1) => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (filter) params.set('status', filter);
      const [r, a] = await Promise.all([
        api.get<{ data: Reconciliation[]; pagination: any }>(`/reconciliations?${params}`),
        api.get<{ data: Account[] }>('/accounts?limit=100'),
      ]);
      setRecons(r.data);
      setPagination(r.pagination);
      setAccounts(a.data);
    } catch (err) { console.error('Reconciliation load error:', err); } finally { setLoading(false); }
  };

  const loadBankData = useCallback(async (accountId: string) => {
    if (!accountId) return;
    setBankLoading(true);
    try {
      const [stmts, unmatched, m] = await Promise.all([
        api.get<{ data: StatementEntry[]; pagination: any }>(`/bank-reconciliation/statements?accountId=${accountId}&matched=false`),
        api.get<{ data: { statements: StatementEntry[]; transactions: UnmatchedTxn[] } }>(`/bank-reconciliation/unmatched/${accountId}`),
        api.get<{ data: MatchRecord[] }>(`/bank-reconciliation/matches/${accountId}`),
      ]);
      setStatements(stmts.data);
      setUnmatchedTxns(unmatched.data.transactions);
      setMatches(m.data);
    } catch (err) { console.error('Bank data load error:', err); } finally { setBankLoading(false); }
  }, []);

  useEffect(() => { loadRecons(); }, [filter]);
  useEffect(() => { if (bankAccountId && tab === 'bank-reconciliation') loadBankData(bankAccountId); }, [bankAccountId, tab, loadBankData]);

  const handleReconSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post('/reconciliations', { ...form, actualBalance: parseFloat(form.actualBalance) });
      setShowModal(false);
      setForm({ accountId: '', actualBalance: '', notes: '' });
      loadRecons();
    } catch (err: any) { alert(err.response?.data?.message || 'Failed'); } finally { setSubmitting(false); }
  };

  const handleAdjust = async () => {
    if (!showDetail) return;
    try {
      await api.post(`/reconciliations/${showDetail.id}/adjust`, { ...adjustForm, adjustmentAmount: parseFloat(adjustForm.adjustmentAmount) });
      setShowDetail(null);
      setAdjustForm({ adjustmentAmount: '', reason: '' });
      loadRecons();
    } catch (err: any) { alert(err.response?.data?.message || 'Failed'); }
  };

  const handleComplete = async (id: string) => {
    if (!confirm('Mark as reconciled?')) return;
    try { await api.post(`/reconciliations/${id}/complete`); loadRecons(); } catch (err: any) { alert(err.response?.data?.message || 'Failed'); }
  };

  const viewDetail = async (r: Reconciliation) => {
    try { const res = await api.get<any>(`/reconciliations/${r.id}`); setShowDetail(res); } catch (err) { console.error('Reconciliation detail error:', err); }
  };

  const handleAutoMatch = async () => {
    if (!bankAccountId) return;
    setAutoMatching(true);
    try {
      const res = await api.post<{ data: { matched: number } }>('/bank-reconciliation/auto-match', { accountId: bankAccountId });
      alert(`Auto-matched ${res.data.matched} transaction(s)`);
      loadBankData(bankAccountId);
    } catch (err: any) { alert(err.response?.data?.message || 'Failed'); } finally { setAutoMatching(false); }
  };

  const handleManualMatch = async () => {
    if (!selectedStmt || !selectedTxn) return;
    try {
      await api.post('/bank-reconciliation/manual-match', { statementId: selectedStmt, transactionId: selectedTxn });
      setSelectedStmt(null);
      setSelectedTxn(null);
      loadBankData(bankAccountId);
    } catch (err: any) { alert(err.response?.data?.message || 'Failed'); }
  };

  const handleUnmatch = async (matchId: string) => {
    if (!confirm('Unmatch this pair?')) return;
    try { await api.post(`/bank-reconciliation/unmatch/${matchId}`); loadBankData(bankAccountId); } catch (err: any) { alert(err.response?.data?.message || 'Failed'); }
  };

  const handleImportCSV = async () => {
    if (!bankAccountId || !importText.trim()) return;
    try {
      const lines = importText.trim().split('\n');
      const entries = lines.map(line => {
        const [date, desc, ref, debit, credit, balance] = line.split(',').map(s => s.trim());
        return { date, description: desc, referenceNumber: ref, debit: parseFloat(debit || '0'), credit: parseFloat(credit || '0'), balance: balance ? parseFloat(balance) : null };
      }).filter(e => e.date);
      await api.post('/bank-reconciliation/statements/import', { accountId: bankAccountId, entries });
      setShowImportModal(false);
      setImportText('');
      loadBankData(bankAccountId);
    } catch (err: any) { alert(err.message || 'Import failed'); }
  };

  const handleManualEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bankAccountId) return;
    try {
      await api.post('/bank-reconciliation/statements/manual-import', {
        accountId: bankAccountId, date: manualForm.date, description: manualForm.description,
        referenceNumber: manualForm.referenceNumber, debit: parseFloat(manualForm.debit || '0'),
        credit: parseFloat(manualForm.credit || '0'), balance: manualForm.balance ? parseFloat(manualForm.balance) : null,
      });
      setShowManualEntry(false);
      setManualForm({ date: '', description: '', referenceNumber: '', debit: '', credit: '', balance: '' });
      loadBankData(bankAccountId);
    } catch (err: any) { alert(err.message || 'Failed'); }
  };

  const handleDeleteStatement = async (id: string) => {
    if (!confirm('Delete this statement entry?')) return;
    try { await api.delete(`/bank-reconciliation/statements/${id}`); loadBankData(bankAccountId); } catch (err: any) { alert(err.message); }
  };

  const statusColor = (s: string) => {
    if (s === 'matched' || s === 'reconciled') return 'bg-green-100 text-green-700';
    if (s === 'variance') return 'bg-red-100 text-red-700';
    if (s === 'adjusted') return 'bg-blue-100 text-blue-700';
    return 'bg-yellow-100 text-yellow-700';
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Reconciliation</h2>
        <p className="text-sm text-gray-600">Balance reconciliation and bank statement matching</p>
      </div>

      <div className="flex gap-1 border-b">
        <button onClick={() => setTab('reconciliation')} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === 'reconciliation' ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
          Balance Reconciliation
        </button>
        <button onClick={() => setTab('bank-reconciliation')} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === 'bank-reconciliation' ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
          Bank Reconciliation
        </button>
      </div>

      {tab === 'reconciliation' && (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-gray-400" />
              <select value={filter} onChange={e => setFilter(e.target.value)} className="input-field max-w-xs">
                <option value="">All Status</option>
                <option value="pending">Pending</option>
                <option value="matched">Matched</option>
                <option value="variance">Variance</option>
                <option value="adjusted">Adjusted</option>
                <option value="reconciled">Reconciled</option>
              </select>
            </div>
            <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" /> New Reconciliation
            </button>
          </div>

          {loading ? (
            <div className="card"><div className="text-center py-12 text-gray-500">Loading...</div></div>
          ) : recons.length === 0 ? (
            <div className="card"><div className="text-center py-12 text-gray-500">
              <Scale className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="font-medium">No reconciliations yet</p>
            </div></div>
          ) : (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[800px]">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Account</th>
                      <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Expected</th>
                      <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Actual</th>
                      <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Variance</th>
                      <th className="text-center px-6 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Date</th>
                      <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {recons.map(r => (
                      <tr key={r.id} className="hover:bg-gray-50">
                        <td className="px-6 py-3.5 text-sm font-medium whitespace-nowrap">{r.account_name}</td>
                        <td className="px-6 py-3.5 text-sm text-right whitespace-nowrap">{formatCurrency(r.expected_balance)}</td>
                        <td className="px-6 py-3.5 text-sm font-medium text-right whitespace-nowrap">{formatCurrency(r.actual_balance)}</td>
                        <td className={`px-6 py-3.5 text-sm font-medium text-right whitespace-nowrap ${Math.abs(r.variance) > 0.01 ? 'text-red-600' : 'text-green-600'}`}>{formatCurrency(r.variance)}</td>
                        <td className="px-6 py-3.5 text-center"><span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${statusColor(r.status)}`}>{r.status}</span></td>
                        <td className="px-6 py-3.5 text-sm text-gray-600 whitespace-nowrap">{new Date(r.created_at).toLocaleDateString()}</td>
                        <td className="px-6 py-3.5 text-right">
                          <div className="flex gap-1 justify-end">
                            <button onClick={() => viewDetail(r)} className="p-1 hover:bg-gray-100 rounded"><Eye className="w-4 h-4" /></button>
                            {r.status === 'matched' && <button onClick={() => handleComplete(r.id)} className="p-1 hover:bg-green-100 rounded text-green-600"><Check className="w-4 h-4" /></button>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-6 pb-4">
                <Pagination page={pagination.page} totalPages={pagination.totalPages} total={pagination.total} onPageChange={loadRecons} />
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'bank-reconciliation' && (
        <>
          <div className="flex items-center gap-4">
            <div className="flex-1 max-w-sm">
              <label className="text-xs text-gray-500">Select Account</label>
              <select value={bankAccountId} onChange={e => setBankAccountId(e.target.value)} className="input-field text-sm">
                <option value="">Select account</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({formatCurrency(a.current_balance)})</option>)}
              </select>
            </div>
            {bankAccountId && (
              <div className="flex gap-2 pt-5">
                <button onClick={() => setShowImportModal(true)} className="btn-secondary flex items-center gap-2 text-sm"><Upload className="w-4 h-4" /> Import CSV</button>
                <button onClick={() => setShowManualEntry(true)} className="btn-secondary flex items-center gap-2 text-sm"><Plus className="w-4 h-4" /> Add Entry</button>
                <button onClick={handleAutoMatch} disabled={autoMatching} className="btn-primary flex items-center gap-2 text-sm">
                  <RefreshCw className={`w-4 h-4 ${autoMatching ? 'animate-spin' : ''}`} />
                  {autoMatching ? 'Matching...' : 'Auto-Match'}
                </button>
              </div>
            )}
          </div>

          {bankAccountId && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div className="card">
                  <h3 className="font-semibold mb-3">Bank Statement Entries (Unmatched)</h3>
                  {bankLoading ? <p className="text-sm text-gray-500 py-4">Loading...</p> : statements.length === 0 ? (
                    <p className="text-sm text-gray-500 py-4">No unmatched statement entries. Import a bank statement to begin.</p>
                  ) : (
                    <div className="space-y-2 max-h-[400px] overflow-y-auto">
                      {statements.map(s => (
                        <div key={s.id} onClick={() => setSelectedStmt(selectedStmt === s.id ? null : s.id)}
                          className={`p-3 rounded-lg border cursor-pointer transition-colors ${selectedStmt === s.id ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                          <div className="flex justify-between items-start">
                            <div>
                              <p className="text-sm font-medium">{s.description || 'No description'}</p>
                              <p className="text-xs text-gray-500">{new Date(s.statement_date).toLocaleDateString()} {s.reference_number && `• Ref: ${s.reference_number}`}</p>
                            </div>
                            <div className="text-right">
                              {parseFloat(String(s.credit)) > 0 && <p className="text-sm font-medium text-green-600">+{formatCurrency(s.credit)}</p>}
                              {parseFloat(String(s.debit)) > 0 && <p className="text-sm font-medium text-red-600">-{formatCurrency(s.debit)}</p>}
                              {s.balance != null && <p className="text-xs text-gray-500">Bal: {formatCurrency(s.balance)}</p>}
                            </div>
                          </div>
                          <div className="flex justify-end mt-1">
                            <button onClick={(e) => { e.stopPropagation(); handleDeleteStatement(s.id); }} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-3 h-3" /></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-4">
                <div className="card">
                  <h3 className="font-semibold mb-3">System Transactions (Unmatched)</h3>
                  {bankLoading ? <p className="text-sm text-gray-500 py-4">Loading...</p> : unmatchedTxns.length === 0 ? (
                    <p className="text-sm text-gray-500 py-4">All transactions are matched.</p>
                  ) : (
                    <div className="space-y-2 max-h-[400px] overflow-y-auto">
                      {unmatchedTxns.map(t => (
                        <div key={t.id} onClick={() => setSelectedTxn(selectedTxn === t.id ? null : t.id)}
                          className={`p-3 rounded-lg border cursor-pointer transition-colors ${selectedTxn === t.id ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                          <div className="flex justify-between items-start">
                            <div>
                              <p className="text-sm font-medium">#{t.transaction_number} — {t.type_name}</p>
                              <p className="text-xs text-gray-500">{new Date(t.transaction_date).toLocaleDateString()} {t.description && `• ${t.description}`}</p>
                            </div>
                            <p className={`text-sm font-medium ${t.direction === 'in' ? 'text-green-600' : 'text-red-600'}`}>
                              {t.direction === 'in' ? '+' : '-'}{formatCurrency(t.amount)}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {selectedStmt && selectedTxn && (
                  <div className="card border-primary-200 bg-primary-50">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-primary-700">Match selected pair?</p>
                      <button onClick={handleManualMatch} className="btn-primary text-sm flex items-center gap-1">
                        <ArrowRight className="w-4 h-4" /> Match
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {bankAccountId && matches.length > 0 && (
            <div className="card overflow-hidden">
              <h3 className="font-semibold px-6 pt-4">Matched Pairs ({matches.length})</h3>
              <div className="overflow-x-auto mt-3">
                <table className="w-full min-w-[1000px]">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Type</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Statement Date</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Statement Desc</th>
                      <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Statement Amount</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Txn #</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Txn Type</th>
                      <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Txn Amount</th>
                      <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {matches.map(m => (
                      <tr key={m.id} className="hover:bg-gray-50">
                        <td className="px-6 py-3 text-sm whitespace-nowrap">
                          <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${m.match_type === 'auto' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>{m.match_type}</span>
                        </td>
                        <td className="px-6 py-3 text-sm whitespace-nowrap">{new Date(m.statement_date).toLocaleDateString()}</td>
                        <td className="px-6 py-3 text-sm whitespace-nowrap">{m.stmt_desc || '-'}</td>
                        <td className="px-6 py-3 text-sm text-right whitespace-nowrap">{parseFloat(String(m.stmt_credit)) > 0 ? formatCurrency(m.stmt_credit) : `-${formatCurrency(m.stmt_debit)}`}</td>
                        <td className="px-6 py-3 text-sm font-mono whitespace-nowrap">#{m.transaction_number}</td>
                        <td className="px-6 py-3 text-sm whitespace-nowrap">{m.type_name}</td>
                        <td className={`px-6 py-3 text-sm font-medium text-right whitespace-nowrap ${m.direction === 'in' ? 'text-green-600' : 'text-red-600'}`}>{m.direction === 'in' ? '+' : '-'}{formatCurrency(m.txn_amount)}</td>
                        <td className="px-6 py-3 text-right">
                          <button onClick={() => handleUnmatch(m.id)} className="p-1 text-gray-400 hover:text-red-500" title="Unmatch"><X className="w-4 h-4" /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">New Reconciliation</h3>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleReconSubmit} className="space-y-4">
              <div>
                <label className="form-label">Account *</label>
                <select required value={form.accountId} onChange={e => setForm({ ...form, accountId: e.target.value })} className="input-field">
                  <option value="">Select account</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name} (System: {formatCurrency(a.current_balance)})</option>)}
                </select>
              </div>
              <div>
                <label className="form-label">Actual Balance (per bank/statement) *</label>
                <input type="number" step="0.01" required value={form.actualBalance} onChange={e => setForm({ ...form, actualBalance: e.target.value })} className="input-field" placeholder="0.00" />
              </div>
              {form.accountId && form.actualBalance && (
                <div className="p-3 rounded-lg text-sm" style={{ backgroundColor: Math.abs(parseFloat(form.actualBalance || '0') - (accounts.find(a => a.id === form.accountId)?.current_balance || 0)) < 0.01 ? '#f0fdf4' : '#fef2f2' }}>
                  <p>System Balance: {formatCurrency(accounts.find(a => a.id === form.accountId)?.current_balance || 0)}</p>
                  <p>Actual Balance: {formatCurrency(parseFloat(form.actualBalance || '0'))}</p>
                  <p className="font-medium mt-1">Variance: {formatCurrency(parseFloat(form.actualBalance || '0') - (accounts.find(a => a.id === form.accountId)?.current_balance || 0))}</p>
                </div>
              )}
              <div>
                <label className="form-label">Notes</label>
                <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="input-field" rows={2} placeholder="Optional notes" />
              </div>
              <div className="flex gap-3 justify-end">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">Cancel</button>
                <button type="submit" disabled={submitting} className="btn-primary">{submitting ? 'Creating...' : 'Create Reconciliation'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showDetail && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">Reconciliation Detail</h3>
              <button onClick={() => setShowDetail(null)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3 text-sm">
              <div><p className="text-gray-500">Account</p><p className="font-medium">{showDetail.account_name}</p></div>
              <div className="grid grid-cols-3 gap-4">
                <div><p className="text-gray-500">Expected</p><p className="font-medium">{formatCurrency(showDetail.expected_balance)}</p></div>
                <div><p className="text-gray-500">Actual</p><p className="font-medium">{formatCurrency(showDetail.actual_balance)}</p></div>
                <div><p className="text-gray-500">Variance</p><p className={`font-medium ${Math.abs(showDetail.variance) > 0.01 ? 'text-red-600' : 'text-green-600'}`}>{formatCurrency(showDetail.variance)}</p></div>
              </div>
              <div><p className="text-gray-500">Status</p><span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${statusColor(showDetail.status)}`}>{showDetail.status}</span></div>
              {showDetail.notes && <div><p className="text-gray-500">Notes</p><p>{showDetail.notes}</p></div>}
              {showDetail.status !== 'reconciled' && Math.abs(showDetail.variance) > 0.01 && (
                <div className="pt-3 border-t">
                  <p className="text-gray-500 mb-2">Apply Adjustment</p>
                  <div className="flex gap-2 mb-2">
                    <input type="number" step="0.01" value={adjustForm.adjustmentAmount} onChange={e => setAdjustForm({ ...adjustForm, adjustmentAmount: e.target.value })} className="input-field flex-1" placeholder="Amount (+/-)" />
                    <input type="text" value={adjustForm.reason} onChange={e => setAdjustForm({ ...adjustForm, reason: e.target.value })} className="input-field flex-1" placeholder="Reason" />
                    <button onClick={handleAdjust} className="btn-primary text-sm">Apply</button>
                  </div>
                </div>
              )}
              <div className="pt-2 border-t text-xs text-gray-400">
                <p>Created: {new Date(showDetail.created_at).toLocaleString()}</p>
                {showDetail.reconciled_at && <p>Reconciled: {new Date(showDetail.reconciled_at).toLocaleString()} by {showDetail.reconciled_by_email}</p>}
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={() => setShowDetail(null)} className="btn-secondary">Close</button>
            </div>
          </div>
        </div>
      )}

      {showImportModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">Import Bank Statement (CSV)</h3>
              <button onClick={() => setShowImportModal(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <p className="text-sm text-gray-600">Paste CSV data. Format: <code className="bg-gray-100 px-1">date, description, reference, debit, credit, balance</code></p>
              <textarea value={importText} onChange={e => setImportText(e.target.value)} className="input-field" rows={8} placeholder="2026-01-15, Transfer from John, REF001, 0, 5000, 15000&#10;2026-01-16, Utility Payment, REF002, 1200, 0, 13800" />
              <div className="flex gap-3 justify-end">
                <button onClick={() => setShowImportModal(false)} className="btn-secondary">Cancel</button>
                <button onClick={handleImportCSV} disabled={!importText.trim()} className="btn-primary">Import</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showManualEntry && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">Add Statement Entry</h3>
              <button onClick={() => setShowManualEntry(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleManualEntry} className="space-y-4">
              <div>
                <label className="form-label">Date *</label>
                <input type="date" required value={manualForm.date} onChange={e => setManualForm({ ...manualForm, date: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="form-label">Description</label>
                <input type="text" value={manualForm.description} onChange={e => setManualForm({ ...manualForm, description: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="form-label">Reference Number</label>
                <input type="text" value={manualForm.referenceNumber} onChange={e => setManualForm({ ...manualForm, referenceNumber: e.target.value })} className="input-field" />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="form-label">Debit</label>
                  <input type="number" step="0.01" min="0" value={manualForm.debit} onChange={e => setManualForm({ ...manualForm, debit: e.target.value })} className="input-field" placeholder="0.00" />
                </div>
                <div>
                  <label className="form-label">Credit</label>
                  <input type="number" step="0.01" min="0" value={manualForm.credit} onChange={e => setManualForm({ ...manualForm, credit: e.target.value })} className="input-field" placeholder="0.00" />
                </div>
                <div>
                  <label className="form-label">Balance</label>
                  <input type="number" step="0.01" value={manualForm.balance} onChange={e => setManualForm({ ...manualForm, balance: e.target.value })} className="input-field" placeholder="Optional" />
                </div>
              </div>
              <div className="flex gap-3 justify-end">
                <button type="button" onClick={() => setShowManualEntry(false)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">Add Entry</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
