import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { ArrowLeftRight, Plus, Search, Eye, Check, X, Filter, Trash2 } from 'lucide-react';
import Pagination from '../components/Pagination';
import AccountSelect from '../components/AccountSelect';

interface Transfer {
  id: string; transfer_number: number; source_name: string; destination_name: string;
  source_masked: string; dest_masked: string; transfer_amount: number; transfer_fee: number;
  total_source_deduction: number; destination_amount: number; status: string; transfer_date: string; purpose: string;
  created_by_email: string; completed_at: string; notes: string;
}

interface Account { id: string; name: string; masked_account_number: string; current_balance: number; provider_id: string; provider_name: string; status: string; }

export default function FundTransfers() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showDetail, setShowDetail] = useState<Transfer | null>(null);
  const [detailEntries, setDetailEntries] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [form, setForm] = useState({ sourceAccountId: '', destinationAccountId: '', transferAmount: '', serviceCharge: '0', purpose: '', notes: '', transferDate: '' });
  const [chargeMode, setChargeMode] = useState<'auto' | 'manual'>('auto');
  const [chargeRule, setChargeRule] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadData = async (page = 1) => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (filter) params.set('status', filter);
      const [t, a] = await Promise.all([
        api.get<{ data: Transfer[]; pagination: any }>(`/transfers?${params}`),
        api.get<{ data: Account[] }>('/accounts?limit=100'),
      ]);
      setTransfers(t.data);
      setPagination(t.pagination);
      setAccounts(a.data);
    } catch (err) { console.error('FundTransfers load error:', err); } finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, [filter]);

  useEffect(() => {
    if (chargeMode !== 'auto' || !form.sourceAccountId || !form.destinationAccountId) return;
    const src = accounts.find(a => a.id === form.sourceAccountId);
    const dst = accounts.find(a => a.id === form.destinationAccountId);
    if (!src?.provider_id || !dst?.provider_id) return;
    let cancelled = false;
    api.get<{ amount: number; rule: { name: string } | null }>(
      `/provider-charges/lookup?sourceProviderId=${src.provider_id}&destinationProviderId=${dst.provider_id}`
    ).then(res => {
      if (cancelled) return;
      setForm(f => ({ ...f, serviceCharge: String(res.amount) }));
      setChargeRule(res.rule ? res.rule.name : null);
    }).catch(err => console.error('Provider charge lookup error:', err));
    return () => { cancelled = true; };
  }, [accounts, form.sourceAccountId, form.destinationAccountId, chargeMode]);

  const openCreate = () => {
    setChargeMode('auto');
    setChargeRule(null);
    setShowModal(true);
  };

  const filtered = transfers.filter(t =>
    !search || t.source_name.toLowerCase().includes(search.toLowerCase()) ||
    t.destination_name.toLowerCase().includes(search.toLowerCase()) ||
    t.purpose?.toLowerCase().includes(search.toLowerCase())
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.sourceAccountId || !form.destinationAccountId) { alert('Please select source and destination accounts'); return; }
    setSubmitting(true);
    try {
      await api.post('/transfers', {
        ...form, transferAmount: parseFloat(form.transferAmount), serviceCharge: parseFloat(form.serviceCharge || '0'),
        manualCharge: chargeMode === 'manual',
        transferDate: form.transferDate || undefined,
      });
      setShowModal(false);
      setForm({ sourceAccountId: '', destinationAccountId: '', transferAmount: '', serviceCharge: '0', purpose: '', notes: '', transferDate: '' });
      setChargeMode('auto');
      setChargeRule(null);
      loadData(1);
    } catch (err: any) { alert(err.response?.data?.message || 'Transfer failed'); } finally { setSubmitting(false); }
  };

  const handleApprove = async (id: string) => {
    if (!confirm('Approve this transfer?')) return;
    try { await api.post(`/transfers/${id}/approve`); loadData(pagination.page); } catch (err: any) { alert(err.response?.data?.message || 'Failed'); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this transfer? This will restore both account balances.')) return;
    try { await api.delete(`/transfers/${id}`); loadData(pagination.page); } catch (err: any) { alert(err.message || 'Failed'); }
  };

  const viewDetail = async (t: Transfer) => {
    try {
      const res = await api.get<any>(`/transfers/${t.id}`);
      setShowDetail(res);
      setDetailEntries(res.entries || []);
    } catch (err) { console.error('Transfer detail error:', err); }
  };

  const statusColor = (s: string) => {
    if (s === 'completed') return 'bg-green-100 text-green-700';
    if (s === 'pending') return 'bg-yellow-100 text-yellow-700';
    if (s === 'failed') return 'bg-red-100 text-red-700';
    return 'bg-gray-100 text-gray-700';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Fund Transfers</h2>
          <p className="text-sm text-gray-600">Transfer funds between accounts</p>
        </div>
        <button onClick={openCreate} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Transfer
        </button>
      </div>

      <div className="flex gap-4 items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
          <input type="text" placeholder="Search transfers..." value={search} onChange={e => setSearch(e.target.value)}
            className="input-field pl-9" />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <select value={filter} onChange={e => setFilter(e.target.value)} className="input-field">
            <option value="">All Status</option>
            <option value="pending">Pending</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="reversal_requested">Reversal Requested</option>
            <option value="reversed">Reversed</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="card"><div className="text-center py-12 text-gray-500">Loading...</div></div>
      ) : filtered.length === 0 ? (
        <div className="card"><div className="text-center py-12 text-gray-500">
          <ArrowLeftRight className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p className="font-medium">No transfers found</p>
        </div></div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">#</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Source</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Destination</th>
                  <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Amount</th>
                  <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Service Charge</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Date</th>
                  <th className="text-center px-6 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Created By</th>
                  <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filtered.map(t => (
                  <tr key={t.id} className="hover:bg-gray-50">
                    <td className="px-6 py-3.5 font-mono text-sm whitespace-nowrap">{t.transfer_number}</td>
                    <td className="px-6 py-3.5 whitespace-nowrap"><p className="text-sm font-medium">{t.source_name}</p><p className="text-xs text-gray-500">{t.source_masked}</p></td>
                    <td className="px-6 py-3.5 whitespace-nowrap"><p className="text-sm font-medium">{t.destination_name}</p><p className="text-xs text-gray-500">{t.dest_masked}</p></td>
                    <td className="px-6 py-3.5 font-medium text-right whitespace-nowrap">{formatCurrency(t.transfer_amount)}</td>
                    <td className="px-6 py-3.5 text-gray-600 text-right whitespace-nowrap">{parseFloat(String(t.transfer_fee)) > 0 ? formatCurrency(parseFloat(String(t.transfer_fee))) : '-'}</td>
                    <td className="px-6 py-3.5 text-sm text-gray-600 whitespace-nowrap">{new Date(t.transfer_date).toLocaleDateString()}</td>
                    <td className="px-6 py-3.5 text-center"><span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${statusColor(t.status)}`}>{t.status}</span></td>
                    <td className="px-6 py-3.5 text-sm text-gray-600 whitespace-nowrap">{t.created_by_email || '-'}</td>
                    <td className="px-6 py-3.5 text-right">
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => viewDetail(t)} className="p-1 hover:bg-gray-100 rounded"><Eye className="w-4 h-4" /></button>
                        {t.status === 'pending' && (
                          <button onClick={() => handleApprove(t.id)} className="p-1 hover:bg-green-100 rounded text-green-600"><Check className="w-4 h-4" /></button>
                        )}
                        <button onClick={() => handleDelete(t.id)} className="p-1 hover:bg-red-100 rounded text-red-600"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-6 pb-4">
            <Pagination page={pagination.page} totalPages={pagination.totalPages} total={pagination.total} onPageChange={loadData} />
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">New Fund Transfer</h3>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="form-label">Source Account *</label>
                <AccountSelect
                  accounts={accounts.filter(a => a.status === 'active')}
                  value={form.sourceAccountId}
                  onChange={id => setForm({ ...form, sourceAccountId: id, destinationAccountId: form.destinationAccountId === id ? '' : form.destinationAccountId })}
                  placeholder="Select source account"
                />
              </div>
              <div>
                <label className="form-label">Destination Account *</label>
                <AccountSelect
                  accounts={accounts.filter(a => a.status === 'active' && a.id !== form.sourceAccountId)}
                  value={form.destinationAccountId}
                  onChange={id => setForm({ ...form, destinationAccountId: id })}
                  placeholder="Select destination account"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Amount *</label>
                  <input type="number" step="0.01" min="0.01" required value={form.transferAmount} onChange={e => setForm({ ...form, transferAmount: e.target.value })} className="input-field" placeholder="0.00" />
                </div>
                <div>
                  <label className="form-label">Service Charge</label>
                  <input
                    type="number" step="0.01" min="0"
                    value={form.serviceCharge}
                    readOnly={chargeMode === 'auto'}
                    onChange={e => setForm({ ...form, serviceCharge: e.target.value })}
                    className={`input-field ${chargeMode === 'auto' ? 'bg-gray-50 text-gray-500 cursor-not-allowed' : ''}`}
                    placeholder="0.00"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    {chargeMode === 'auto'
                      ? (chargeRule ? `Auto — provider rule: ${chargeRule}` : 'Auto — no matching provider rule')
                      : 'Manual — you decide the charge amount'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={chargeMode === 'manual'} onChange={e => setChargeMode(e.target.checked ? 'manual' : 'auto')} className="sr-only peer" />
                  <div className="w-9 h-5 bg-gray-200 peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                </label>
                <span className="text-sm text-gray-700">Manual Charge</span>
                <span className="text-xs text-gray-500">({chargeMode === 'auto' ? 'Charge auto-calculated from provider rules' : 'You decide the charge amount'})</span>
              </div>
              <div>
                <label className="form-label">Transfer Date</label>
                <input type="datetime-local" value={form.transferDate} onChange={e => setForm({ ...form, transferDate: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="form-label">Purpose</label>
                <input type="text" value={form.purpose} onChange={e => setForm({ ...form, purpose: e.target.value })} className="input-field" placeholder="Optional purpose" />
              </div>
              <div>
                <label className="form-label">Notes</label>
                <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="input-field" rows={2} placeholder="Optional notes" />
              </div>
              {form.sourceAccountId && form.transferAmount && (
                <div className="p-3 bg-gray-50 rounded-lg text-sm space-y-1">
                  <p>Source will be debited: <span className="font-medium text-red-600">{formatCurrency(parseFloat(form.transferAmount || '0') + parseFloat(form.serviceCharge || '0'))}</span></p>
                  <p>Destination will receive: <span className="font-medium text-green-600">{formatCurrency(parseFloat(form.transferAmount || '0'))}</span></p>
                  <p className="text-xs text-gray-500">Service charge: {formatCurrency(parseFloat(form.serviceCharge || '0'))} (deducted from source account)</p>
                </div>
              )}
              <div className="flex gap-3 justify-end">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">Cancel</button>
                <button type="submit" disabled={submitting} className="btn-primary">{submitting ? 'Processing...' : 'Create Transfer'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showDetail && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">Transfer #{showDetail.transfer_number}</h3>
              <button onClick={() => setShowDetail(null)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-4">
                <div><p className="text-gray-500">From</p><p className="font-medium">{showDetail.source_name}</p><p className="text-xs text-gray-400">{showDetail.source_masked}</p></div>
                <div><p className="text-gray-500">To</p><p className="font-medium">{showDetail.destination_name}</p><p className="text-xs text-gray-400">{showDetail.dest_masked}</p></div>
              </div>
              <div className="grid grid-cols-3 gap-4 pt-2 border-t">
                <div><p className="text-gray-500">Amount</p><p className="font-medium">{formatCurrency(showDetail.transfer_amount)}</p></div>
                <div><p className="text-gray-500">Service Charge</p><p className="font-medium">{formatCurrency(parseFloat(String(showDetail.transfer_fee)))}</p></div>
                <div><p className="text-gray-500">Total Deducted</p><p className="font-medium text-red-600">{formatCurrency(showDetail.total_source_deduction)}</p></div>
              </div>
              <div className="pt-2 border-t">
                <p className="text-gray-500">Destination Receives</p>
                <p className="font-medium text-green-600">{formatCurrency(showDetail.destination_amount)}</p>
              </div>
              <div className="pt-2 border-t">
                <p className="text-gray-500">Status</p><span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${statusColor(showDetail.status)}`}>{showDetail.status}</span>
              </div>
              {showDetail.purpose && <div><p className="text-gray-500">Purpose</p><p>{showDetail.purpose}</p></div>}
              {showDetail.notes && <div><p className="text-gray-500">Notes</p><p>{showDetail.notes}</p></div>}
              {detailEntries.length > 0 && (
                <div className="pt-2 border-t">
                  <p className="text-gray-500 mb-2">Ledger Entries</p>
                  {detailEntries.map((e: any) => (
                    <div key={e.id} className="flex justify-between p-2 bg-gray-50 rounded mb-1">
                      <span className="text-xs">{e.entry_category} ({e.entry_type})</span>
                      <span className={`text-xs font-medium ${e.entry_type === 'debit' ? 'text-red-600' : 'text-green-600'}`}>{e.entry_type === 'debit' ? '-' : '+'}{formatCurrency(e.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="pt-2 border-t text-xs text-gray-400">
                <p>Created: {new Date(showDetail.transfer_date).toLocaleString()} by {showDetail.created_by_email}</p>
                {showDetail.completed_at && <p>Completed: {new Date(showDetail.completed_at).toLocaleString()}</p>}
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={() => setShowDetail(null)} className="btn-secondary">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
