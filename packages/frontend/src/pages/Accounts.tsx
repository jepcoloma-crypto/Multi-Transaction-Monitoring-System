import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { useAuth } from '../contexts/AuthContext';
import { Plus, Search, Edit2, Eye, X, Wallet, DollarSign, Trash2 } from 'lucide-react';

interface Account {
  id: string;
  name: string;
  provider_id: string;
  provider_name: string;
  provider_code: string;
  account_type_id: string;
  type_name: string;
  type_code: string;
  masked_account_number: string | null;
  account_reference: string | null;
  owner: string | null;
  purpose: string | null;
  opening_balance: number;
  current_balance: number;
  minimum_balance: number;
  target_balance: number;
  status: string;
  notes: string | null;
  created_at: string;
  created_by: string | null;
  created_by_email: string | null;
}

interface Provider { id: string; name: string; code: string; }
interface AccountType { id: string; name: string; code: string; }
interface TransactionType { id: string; name: string; code: string; direction: string; }
interface AccountSummary {
  summary: { totalAccounts: number; totalBalance: number; activeAccounts: number; lowBalanceCount: number };
}

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [accountTypes, setAccountTypes] = useState<AccountType[]>([]);
  const [transactionTypes, setTransactionTypes] = useState<TransactionType[]>([]);
  const [summary, setSummary] = useState<AccountSummary['summary'] | null>(null);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showDetail, setShowDetail] = useState<Account | null>(null);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [formData, setFormData] = useState({
    name: '', providerId: '', accountTypeId: '', maskedAccountNumber: '',
    accountReference: '', owner: '', purpose: '', openingBalance: '0',
    minimumBalance: '0', targetBalance: '0', notes: '', currentBalance: '0',
  });
  const [error, setError] = useState('');
  const [showAddFunds, setShowAddFunds] = useState(false);
  const [addFundsAccount, setAddFundsAccount] = useState<Account | null>(null);
  const [addFundsForm, setAddFundsForm] = useState({ amount: '', description: '' });
  const { user } = useAuth();
  const isAdmin = user?.roles?.includes('administrator') ?? false;
  const canManage = (account: Account) => isAdmin || account.created_by === user?.id;

  const fetchSeq = useRef(0);

  const fetchAccounts = async (page = 1) => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      const result = await api.get<{ data: Account[]; pagination: any }>(`/accounts?${params}`);
      if (seq !== fetchSeq.current) return;
      setAccounts(result.data);
      setPagination(result.pagination);
    } catch (err: any) {
      if (seq === fetchSeq.current) setError(err.message);
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  };

  const fetchSummary = async () => {
    try {
      const result = await api.get<AccountSummary>('/accounts/summary');
      setSummary(result.summary);
    } catch (err) { console.error('Account summary error:', err); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this account? Accounts with transactions cannot be deleted.')) return;
    try {
      await api.delete(`/accounts/${id}`);
      fetchAccounts(pagination.page);
      fetchSummary();
    } catch (err: any) { alert(err.message); }
  };

  const fetchMeta = async () => {
    try {
      const [p, t, tt] = await Promise.all([
        api.get<Provider[]>('/providers'),
        api.get<AccountType[]>('/account-types'),
        api.get<TransactionType[]>('/transaction-types/types'),
      ]);
      setProviders(p);
      setAccountTypes(t);
      setTransactionTypes(tt);
    } catch (err) { console.error('Account meta load error:', err); }
  };

  useEffect(() => { fetchAccounts(); fetchSummary(); fetchMeta(); }, []);

  const initialLoad = useRef(true);
  useEffect(() => {
    if (initialLoad.current) {
      initialLoad.current = false;
      return;
    }
    const timer = setTimeout(() => fetchAccounts(1), 300);
    return () => clearTimeout(timer);
  }, [search, statusFilter]);

  const getStatusColor = (account: Account) => {
    if (account.status !== 'active') return 'text-gray-500';
    if (account.current_balance <= 0) return 'text-red-600';
    if (account.current_balance <= account.minimum_balance) return 'text-yellow-600';
    return 'text-green-600';
  };

  const openCreate = () => {
    setEditingAccount(null);
    setFormData({
      name: '', providerId: providers[0]?.id || '', accountTypeId: accountTypes[0]?.id || '',
      maskedAccountNumber: '', accountReference: '', owner: '', purpose: '',
      openingBalance: '0', minimumBalance: '0', targetBalance: '0', notes: '', currentBalance: '0',
    });
    setShowModal(true);
    setError('');
  };

  const openEdit = (account: Account) => {
    setEditingAccount(account);
    setFormData({
      name: account.name, providerId: account.provider_id, accountTypeId: account.account_type_id,
      maskedAccountNumber: account.masked_account_number || '', accountReference: account.account_reference || '',
      owner: account.owner || '', purpose: account.purpose || '',
      openingBalance: String(account.opening_balance), minimumBalance: String(account.minimum_balance),
      targetBalance: String(account.target_balance), notes: account.notes || '',
      currentBalance: String(account.current_balance),
    });
    setShowModal(true);
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const { currentBalance, ...rest } = formData;
      const body: any = {
        ...rest,
        openingBalance: parseFloat(formData.openingBalance) || 0,
        minimumBalance: parseFloat(formData.minimumBalance) || 0,
        targetBalance: parseFloat(formData.targetBalance) || 0,
      };
      if (editingAccount && isAdmin) {
        body.currentBalance = parseFloat(currentBalance);
      }
      if (editingAccount) {
        await api.put(`/accounts/${editingAccount.id}`, body);
      } else {
        await api.post('/accounts', body);
      }
      setShowModal(false);
      fetchAccounts(pagination.page);
      fetchSummary();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleStatusChange = async (accountId: string, status: string) => {
    try {
      await api.put(`/accounts/${accountId}`, { status });
      fetchAccounts(pagination.page);
      fetchSummary();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleAddFunds = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addFundsAccount) return;
    setError('');
    try {
      const amount = parseFloat(addFundsForm.amount);
      if (isNaN(amount) || amount <= 0) {
        setError('Amount must be greater than 0');
        return;
      }
      const cashInType = transactionTypes.find(t => t.code === 'cash_in');
      if (!cashInType) {
        setError('Cash-In transaction type not found');
        return;
      }
      await api.post('/transactions', {
        accountId: addFundsAccount.id,
        transactionTypeId: cashInType.id,
        amount,
        fee: 0,
        feeAddedToBalance: true,
        referenceNumber: null,
        description: addFundsForm.description || `Funds added to ${addFundsAccount.name}`,
        transactionDate: new Date().toISOString(),
        feeRuleId: null,
      });
      setShowAddFunds(false);
      setAddFundsAccount(null);
      setAddFundsForm({ amount: '', description: '' });
      fetchAccounts(pagination.page);
      fetchSummary();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Accounts</h2>
          <p className="text-sm text-gray-600">{pagination.total} account(s)</p>
        </div>
        <button onClick={openCreate} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Account
        </button>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="card py-3">
            <p className="text-xs text-gray-500">Total Accounts</p>
            <p className="text-xl font-bold">{summary.totalAccounts}</p>
          </div>
          <div className="card py-3">
            <p className="text-xs text-gray-500">Total Balance</p>
            <p className="text-xl font-bold text-primary-600">{formatCurrency(summary.totalBalance)}</p>
          </div>
          <div className="card py-3">
            <p className="text-xs text-gray-500">Active</p>
            <p className="text-xl font-bold text-green-600">{summary.activeAccounts}</p>
          </div>
          <div className="card py-3">
            <p className="text-xs text-gray-500">Low Balance</p>
            <p className="text-xl font-bold text-yellow-600">{summary.lowBalanceCount}</p>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input type="text" placeholder="Search accounts..." value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchAccounts(1)}
            className="input pl-10" />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input w-auto">
          <option value="">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="suspended">Suspended</option>
          <option value="closed">Closed</option>
        </select>
        <button onClick={() => fetchAccounts(1)} className="btn-secondary">Search</button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[800px]">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Account</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Provider</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Type</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Balance</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Min Balance</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Created By</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr><td colSpan={8} className="text-center py-8 text-gray-500">Loading...</td></tr>
            ) : error ? (
              <tr><td colSpan={8} className="text-center py-8 text-red-500">{error}</td></tr>
            ) : accounts.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-8 text-gray-500">
                <Wallet className="w-12 h-12 mx-auto mb-3 opacity-50" />
                No accounts found
              </td></tr>
            ) : (
              accounts.map((account) => (
                <tr key={account.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{account.name}</p>
                      {account.masked_account_number && (
                        <p className="text-xs text-gray-500">{account.masked_account_number}</p>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{account.provider_name}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{account.type_name}</td>
                  <td className={`px-4 py-3 text-sm text-right font-medium ${getStatusColor(account)}`}>
                    {formatCurrency(account.current_balance)}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-500">
                    {formatCurrency(account.minimum_balance)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`badge-${account.status === 'active' ? 'green' : account.status === 'suspended' ? 'yellow' : 'gray'}`}>
                      {account.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{account.created_by_email || '-'}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => { setAddFundsAccount(account); setShowAddFunds(true); }} className="p-1 text-gray-400 hover:text-green-600" title="Add Funds">
                        <DollarSign className="w-4 h-4" />
                      </button>
                      <button onClick={() => setShowDetail(account)} className="p-1 text-gray-400 hover:text-primary-600" title="View">
                        <Eye className="w-4 h-4" />
                      </button>
                      {canManage(account) && (
                        <button onClick={() => openEdit(account)} className="p-1 text-gray-400 hover:text-primary-600" title="Edit">
                          <Edit2 className="w-4 h-4" />
                        </button>
                      )}
                      {canManage(account) && (
                        <button onClick={() => handleDelete(account.id)} className="p-1 text-gray-400 hover:text-red-600" title="Delete">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          {Array.from({ length: pagination.totalPages }, (_, i) => i + 1).map((page) => (
            <button key={page} onClick={() => fetchAccounts(page)}
              className={`px-3 py-1 rounded-lg text-sm ${page === pagination.page ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
              {page}
            </button>
          ))}
        </div>
      )}

      {/* Account Detail Modal */}
      {showDetail && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold">{showDetail.name}</h3>
              <button onClick={() => setShowDetail(null)}><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div><p className="text-xs text-gray-500">Provider</p><p className="font-medium">{showDetail.provider_name}</p></div>
                <div><p className="text-xs text-gray-500">Type</p><p className="font-medium">{showDetail.type_name}</p></div>
                <div><p className="text-xs text-gray-500">Account Number</p><p className="font-medium">{showDetail.masked_account_number || '-'}</p></div>
                <div><p className="text-xs text-gray-500">Reference</p><p className="font-medium">{showDetail.account_reference || '-'}</p></div>
                <div><p className="text-xs text-gray-500">Owner</p><p className="font-medium">{showDetail.owner || '-'}</p></div>
                <div><p className="text-xs text-gray-500">Status</p><p className="font-medium">{showDetail.status}</p></div>
              </div>
              <div className="border-t pt-4">
                <h4 className="font-medium mb-3">Balances</h4>
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-gray-50 p-3 rounded-lg">
                    <p className="text-xs text-gray-500">Current Balance</p>
                    <p className={`text-lg font-bold ${getStatusColor(showDetail)}`}>{formatCurrency(showDetail.current_balance)}</p>
                  </div>
                  <div className="bg-gray-50 p-3 rounded-lg">
                    <p className="text-xs text-gray-500">Minimum Balance</p>
                    <p className="text-lg font-bold">{formatCurrency(showDetail.minimum_balance)}</p>
                  </div>
                  <div className="bg-gray-50 p-3 rounded-lg">
                    <p className="text-xs text-gray-500">Target Balance</p>
                    <p className="text-lg font-bold">{formatCurrency(showDetail.target_balance)}</p>
                  </div>
                </div>
              </div>
              {showDetail.purpose && (
                <div className="border-t pt-4">
                  <p className="text-xs text-gray-500">Purpose</p>
                  <p className="text-sm">{showDetail.purpose}</p>
                </div>
              )}
              {showDetail.notes && (
                <div className="border-t pt-4">
                  <p className="text-xs text-gray-500">Notes</p>
                  <p className="text-sm">{showDetail.notes}</p>
                </div>
              )}
              <div className="border-t pt-4 flex gap-2">
                {canManage(showDetail) && showDetail.status === 'active' && (
                  <>
                    <button onClick={() => { handleStatusChange(showDetail.id, 'inactive'); setShowDetail(null); }}
                      className="btn-secondary text-sm">Deactivate</button>
                    <button onClick={() => { handleStatusChange(showDetail.id, 'suspended'); setShowDetail(null); }}
                      className="btn-secondary text-sm text-yellow-600">Suspend</button>
                  </>
                )}
                {canManage(showDetail) && showDetail.status !== 'active' && showDetail.status !== 'closed' && (
                  <button onClick={() => { handleStatusChange(showDetail.id, 'active'); setShowDetail(null); }}
                    className="btn-primary text-sm">Reactivate</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold">{editingAccount ? 'Edit Account' : 'Add Account'}</h3>
              <button onClick={() => setShowModal(false)}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-4 space-y-4">
              {error && <div className="bg-red-50 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Account Name *</label>
                <input type="text" required value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className="input" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Provider *</label>
                  <select required value={formData.providerId} onChange={(e) => setFormData({ ...formData, providerId: e.target.value })} className="input">
                    <option value="">Select provider</option>
                    {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Account Type *</label>
                  <select required value={formData.accountTypeId} onChange={(e) => setFormData({ ...formData, accountTypeId: e.target.value })} className="input">
                    <option value="">Select type</option>
                    {accountTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Masked Account Number *</label>
                  <input type="text" required value={formData.maskedAccountNumber} onChange={(e) => setFormData({ ...formData, maskedAccountNumber: e.target.value })} className="input" placeholder="e.g., ****1234" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Account Reference</label>
                  <input type="text" value={formData.accountReference} onChange={(e) => setFormData({ ...formData, accountReference: e.target.value })} className="input" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Owner</label>
                  <input type="text" value={formData.owner} onChange={(e) => setFormData({ ...formData, owner: e.target.value })} className="input" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Purpose</label>
                  <input type="text" value={formData.purpose} onChange={(e) => setFormData({ ...formData, purpose: e.target.value })} className="input" />
                </div>
              </div>
              {!editingAccount && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Opening Balance</label>
                  <input type="number" step="0.01" min="0" value={formData.openingBalance} onChange={(e) => setFormData({ ...formData, openingBalance: e.target.value })} className="input" />
                </div>
              )}
              {editingAccount && isAdmin && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Balance</label>
                  <input type="number" step="0.01" value={formData.currentBalance} onChange={(e) => setFormData({ ...formData, currentBalance: e.target.value })} className="input" />
                  <p className="text-xs text-gray-500 mt-1">Administrators only — changes are recorded in balance history and the audit log.</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Minimum Balance</label>
                  <input type="number" step="0.01" min="0" value={formData.minimumBalance} onChange={(e) => setFormData({ ...formData, minimumBalance: e.target.value })} className="input" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Target Balance</label>
                  <input type="number" step="0.01" min="0" value={formData.targetBalance} onChange={(e) => setFormData({ ...formData, targetBalance: e.target.value })} className="input" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} className="input" rows={2} />
              </div>
              <div className="flex justify-end gap-2 pt-4">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">{editingAccount ? 'Update' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Add Funds Modal */}
      {showAddFunds && addFundsAccount && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-md">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold">Add Funds to {addFundsAccount.name}</h3>
              <button onClick={() => { setShowAddFunds(false); setAddFundsAccount(null); }}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleAddFunds} className="p-4 space-y-4">
              {error && <div className="bg-red-50 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
                <input type="number" step="0.01" min="0.01" required value={addFundsForm.amount}
                  onChange={(e) => setAddFundsForm({ ...addFundsForm, amount: e.target.value })}
                  className="input" placeholder="0.00" autoFocus />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input type="text" value={addFundsForm.description}
                  onChange={(e) => setAddFundsForm({ ...addFundsForm, description: e.target.value })}
                  className="input" placeholder="Optional note" />
              </div>
              <div className="bg-gray-50 p-3 rounded-lg text-sm">
                <p>Current Balance: <span className="font-medium">{formatCurrency(addFundsAccount.current_balance)}</span></p>
                <p>New Balance: <span className="font-bold text-green-600">{formatCurrency(addFundsAccount.current_balance + (parseFloat(addFundsForm.amount) || 0))}</span></p>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => { setShowAddFunds(false); setAddFundsAccount(null); }} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary flex items-center gap-2"><DollarSign className="w-4 h-4" /> Add Funds</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
