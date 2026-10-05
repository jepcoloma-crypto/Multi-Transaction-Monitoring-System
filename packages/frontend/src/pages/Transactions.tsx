import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { formatCurrency, localDateTimeValue, paymentMethodLabel, paymentMethodOptions } from '../lib/format';
import { Plus, Search, Eye, X, ArrowUpRight, ArrowDownLeft, Trash2, Pencil } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import AccountSelect from '../components/AccountSelect';

const DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01];

const breakdownCash = (value: number): { denom: number; count: number }[] => {
  let cents = Math.round(value * 100);
  const parts: { denom: number; count: number }[] = [];
  for (const denom of DENOMINATIONS) {
    const denomCents = Math.round(denom * 100);
    const count = Math.floor(cents / denomCents);
    if (count > 0) {
      parts.push({ denom, count });
      cents -= count * denomCents;
    }
  }
  return parts;
};

const formatBreakdown = (value: number): string =>
  breakdownCash(value)
    .map(p => `${p.count} × ${p.denom % 1 === 0 ? `₱${p.denom.toLocaleString('en-PH')}` : formatCurrency(p.denom)}`)
    .join(' + ');

const toNum = (v: number | string | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);

interface Transaction {
  id: string;
  transaction_number: number;
  account_id: string;
  account_name: string;
  type_name: string;
  type_code: string;
  direction: string;
  category_name: string | null;
  amount: number;
  fee: number;
  net_amount: number;
  reference_number: string | null;
  description: string | null;
  customer_name: string | null;
  customer_contact: string | null;
  transaction_date: string;
  status: string;
  created_by_username: string | null;
  fee_added_to_balance: boolean;
  additional_charges: { description: string; amount: number }[];
  notes: string | null;
  payment_method: string | null;
  rejection_reason: string | null;
}

interface CustomerHistory {
  customerName: string;
  transactions: Transaction[];
  summary: { totalTransactions: number; totalMoneyIn: number; totalMoneyOut: number; totalFees: number };
}

interface FeeRule {
  id: string; name: string; fee_type: string; fee_value: number;
  min_fee: number; max_fee: number | null; is_active: boolean;
  type_name: string; type_code: string; direction: string;
  category_name: string | null; category_code: string | null;
  transaction_type_id: string; transaction_category_id: string | null;
  base_amount: number; step_amount: number; step_fee: number;
  calculation_method: string;
  tiers?: { id: string; min_amount: number; max_amount: number | null; fee_value: number; fee_type: string }[];
}
interface Account { id: string; name: string; provider_name: string; status: string; current_balance: number; masked_account_number: string; }
interface CustomerOption { id: string; first_name: string; last_name: string; phone: string | null; }
interface Summary { totalMoneyIn: number; totalMoneyOut: number; totalFees: number; transactionCount: number; netMovement: number; }

export default function Transactions() {
  const { user } = useAuth();
  const isAdmin = user?.roles?.includes('administrator') ?? false;
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [feeRules, setFeeRules] = useState<FeeRule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [filters, setFilters] = useState({ search: '', typeId: '', status: '', accountId: '', startDate: '', endDate: '', minAmount: '', maxAmount: '' });
  const [filterTypes, setFilterTypes] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showDetail, setShowDetail] = useState<Transaction | null>(null);
  const [editingCharges, setEditingCharges] = useState(false);
  const [chargeItems, setChargeItems] = useState<{ description: string; amount: string }[]>([]);
  const [feeMode, setFeeMode] = useState<'auto' | 'manual'>('auto');
  const [createCharges, setCreateCharges] = useState<{ description: string; amount: string }[]>([]);
  const [chargeTypes, setChargeTypes] = useState<{ id: string; name: string; default_amount: number }[]>([]);
  const [formData, setFormData] = useState({
    accountId: '', feeRuleId: '', amount: '',
    fee: '0', referenceNumber: '', description: '', customerName: '', transactionDate: localDateTimeValue(),
    feeAddedToBalance: true, notes: '', customerId: '', customerMode: 'select' as 'select' | 'manual', customerPhone: '',
    providerCharge: '',
  });
  const [error, setError] = useState('');
  const [customerHistory, setCustomerHistory] = useState<CustomerHistory | null>(null);
  const [showCustomerHistory, setShowCustomerHistory] = useState(false);
  const [editTx, setEditTx] = useState<Transaction | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const [editForm, setEditForm] = useState({
    transactionDate: '', amount: '', fee: '', feeAddedToBalance: true,
    referenceNumber: '', description: '', customerName: '', customerContact: '',
    paymentMethod: '', notes: '',
  });

  const fetchTransactions = async (page = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (filters.search) params.set('search', filters.search);
      if (filters.typeId) params.set('typeId', filters.typeId);
      if (filters.status) params.set('status', filters.status);
      if (filters.accountId) params.set('accountId', filters.accountId);
      if (filters.startDate) params.set('startDate', filters.startDate);
      if (filters.endDate) params.set('endDate', filters.endDate);
      if (filters.minAmount) params.set('minAmount', filters.minAmount);
      if (filters.maxAmount) params.set('maxAmount', filters.maxAmount);
      const result = await api.get<{ data: Transaction[]; pagination: any }>(`/transactions?${params}`);
      setTransactions(result.data);
      setPagination(result.pagination);
    } catch (err) { console.error('Transactions load error:', err); } finally { setLoading(false); }
  };

  const fetchSummary = async () => {
    try {
      const result = await api.get<{ summary: Summary }>('/transactions/summary');
      setSummary(result.summary);
    } catch (err) { console.error('Transactions summary error:', err); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this transaction?')) return;
    try {
      await api.delete(`/transactions/${id}`);
      fetchTransactions(pagination.page);
      fetchSummary();
    } catch (err: any) { alert(err.message); }
  };

  const canEdit = (tx: Transaction) => isAdmin && tx.status === 'pending';

  const toInputDateTime = (iso: string) => localDateTimeValue(new Date(iso));

  const openEdit = (tx: Transaction) => {
    setEditError('');
    setEditTx(tx);
    setEditForm({
      transactionDate: toInputDateTime(tx.transaction_date),
      amount: String(tx.amount),
      fee: String(tx.fee),
      feeAddedToBalance: tx.fee_added_to_balance,
      referenceNumber: tx.reference_number || '',
      description: tx.description || '',
      customerName: tx.customer_name || '',
      customerContact: tx.customer_contact || '',
      paymentMethod: tx.payment_method || '',
      notes: tx.notes || '',
    });
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTx) return;

    const amount = Number(editForm.amount);
    const fee = Number(editForm.fee);
    const parsedDate = new Date(editForm.transactionDate);
    if (!editForm.transactionDate || Number.isNaN(parsedDate.getTime())) return setEditError('Transaction date is required');
    if (!Number.isFinite(amount) || amount < 0) return setEditError('Amount cannot be negative');
    if (!Number.isFinite(fee) || fee < 0) return setEditError('Fee cannot be negative');

    setEditError('');
    setEditSaving(true);
    try {
      const updated = await api.patch<Transaction>(`/transactions/${editTx.id}`, {
        transactionDate: parsedDate.toISOString(),
        referenceNumber: editForm.referenceNumber,
        description: editForm.description,
        customerName: editForm.customerName,
        customerContact: editForm.customerContact,
        paymentMethod: editForm.paymentMethod,
        notes: editForm.notes,
        amount,
        fee,
        feeAddedToBalance: editForm.feeAddedToBalance,
      });
      if (showDetail && showDetail.id === editTx.id) setShowDetail({ ...showDetail, ...updated });
      setEditTx(null);
      fetchTransactions(pagination.page);
      fetchSummary();
    } catch (err: any) {
      setEditError(err?.message || 'Failed to update transaction');
    } finally {
      setEditSaving(false);
    }
  };

  const fetchMeta = async () => {
    const [rules, a, ct, cust, allTypes] = await Promise.allSettled([
      api.get<FeeRule[]>('/transaction-fees'),
      api.get<{ data: Account[] }>('/accounts?limit=100'),
      api.get<{ id: string; name: string; default_amount: number }[]>('/additional-charges'),
      api.get<{ data: CustomerOption[] }>('/customers?limit=500'),
      api.get<{ id: string; name: string; code: string }[]>('/transaction-types/types'),
    ]);
    if (rules.status === 'fulfilled') {
      setFeeRules(rules.value.filter(r => r.is_active));
      const seen = new Map<string, { id: string; name: string }>();
      rules.value.filter(r => r.is_active).forEach(r => { if (!seen.has(r.type_code)) seen.set(r.type_code, { id: r.transaction_type_id, name: r.type_name }); });
      if (allTypes.status === 'fulfilled') allTypes.value.forEach(t => { if (!seen.has(t.code)) seen.set(t.code, { id: t.id, name: t.name }); });
      setFilterTypes(Array.from(seen.values()));
    } else console.error('Transactions meta: fee rules failed:', rules.reason);
    if (allTypes.status === 'fulfilled' && rules.status !== 'fulfilled') {
      setFilterTypes(allTypes.value.map(t => ({ id: t.id, name: t.name })));
    }
    if (a.status === 'fulfilled') setAccounts(a.value.data);
    else console.error('Transactions meta: accounts failed:', a.reason);
    if (ct.status === 'fulfilled') setChargeTypes(ct.value.filter((c: any) => c.is_active));
    else console.error('Transactions meta: charges failed:', ct.reason);
    if (cust.status === 'fulfilled') setCustomers(cust.value.data);
    else console.error('Transactions meta: customers failed:', cust.reason);
  };

  useEffect(() => { fetchTransactions(); fetchSummary(); fetchMeta(); }, []);

  const fetchCustomerHistory = async (name: string) => {
    try {
      const result = await api.get<CustomerHistory>(`/transactions/by-customer-name?name=${encodeURIComponent(name)}`);
      setCustomerHistory(result);
      setShowCustomerHistory(true);
    } catch (err) { console.error('Customer history error:', err); }
  };

  const selectedRule = feeRules.find(r => r.id === formData.feeRuleId);
  const selectedAccount = accounts.find(a => a.id === formData.accountId);
  const inputAmount = parseFloat(formData.amount) || 0;
  const feeAmount = parseFloat(formData.fee) || 0;
  const chargesTotal = createCharges.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
  const selectedDirection = selectedRule?.direction;
  // The provider's charge is only recordable on a real cash movement, so it
  // counts towards what leaves the balance only when it would actually be
  // posted. A value left behind by an earlier type selection does not — and is
  // dropped from the payload rather than sent and rejected.
  const chargeApplies = selectedDirection === 'in' || selectedDirection === 'out';
  const providerChargeAmount = chargeApplies ? (parseFloat(formData.providerCharge) || 0) : 0;
  const totalOutflow = (formData.feeAddedToBalance
    ? inputAmount + chargesTotal
    : inputAmount - feeAmount + chargesTotal) + providerChargeAmount;
  const hasInsufficientBalance = selectedDirection === 'out' && selectedAccount != null && totalOutflow > 0 && totalOutflow > selectedAccount.current_balance;
  const movementLabel = selectedDirection === 'out'
    ? `Total: ${formatCurrency(totalOutflow)}`
    : `${selectedDirection === 'in' ? 'Cash in' : 'Credited'}: +${formatCurrency(totalOutflow)}`;

  const calculateFee = (rule: FeeRule, amount: number): number => {
    let calcFee: number | null = null;
    if (rule.tiers && rule.tiers.length > 0) {
      const sorted = [...rule.tiers].sort((a, b) => toNum(a.min_amount) - toNum(b.min_amount));
      const matchTier = (amt: number) => {
        let t = sorted.find(x => amt >= toNum(x.min_amount) && (x.max_amount === null || amt <= toNum(x.max_amount)));
        if (!t && amt >= toNum(sorted[0].min_amount)) {
          t = sorted.find(x => amt < toNum(x.min_amount)) || sorted.filter(x => amt >= toNum(x.min_amount)).pop();
        }
        return t;
      };
      const tierFeeOf = (t: { fee_type: string; fee_value: number }, amt: number): number =>
        t.fee_type === 'percentage' ? (amt * toNum(t.fee_value)) / 100 : toNum(t.fee_value);

      if (rule.calculation_method === 'per_amount') {
        const bounded = sorted.filter(t => t.max_amount !== null && t.max_amount !== undefined);
        const chunkTier = bounded.length > 0
          ? [...bounded].sort((a, b) => toNum(b.max_amount) - toNum(a.max_amount))[0]
          : undefined;
        const chunk = chunkTier ? toNum(chunkTier.max_amount) : 0;
        if (chunkTier && chunk > 0) {
          const full = Math.floor(amount / chunk);
          const remainder = amount - full * chunk;
          if (full > 0) {
            calcFee = full * tierFeeOf(chunkTier, chunk);
            const remTier = matchTier(remainder);
            if (remTier) calcFee += tierFeeOf(remTier, remainder);
          } else {
            const remTier = matchTier(remainder);
            if (remTier) calcFee = tierFeeOf(remTier, remainder);
          }
        } else {
          const t = matchTier(amount);
          if (t) calcFee = tierFeeOf(t, amount);
        }
      } else {
        const matchedTier = matchTier(amount);
        if (matchedTier) calcFee = tierFeeOf(matchedTier, amount);
      }
    }
    if (calcFee === null) {
      if (rule.fee_type === 'flat_per_step') {
        const baseAmount = toNum(rule.base_amount);
        const stepAmount = toNum(rule.step_amount) || 1;
        const stepFee = toNum(rule.step_fee);
        calcFee = amount > baseAmount
          ? toNum(rule.fee_value) + Math.ceil((amount - baseAmount) / stepAmount) * stepFee
          : toNum(rule.fee_value);
      } else {
        calcFee = rule.fee_type === 'percentage' ? (amount * toNum(rule.fee_value)) / 100 : toNum(rule.fee_value);
      }
    }
    const minFee = toNum(rule.min_fee);
    const maxFee = toNum(rule.max_fee);
    if (minFee && calcFee < minFee) calcFee = minFee;
    if (maxFee && calcFee > maxFee) calcFee = maxFee;
    return Math.ceil(calcFee - 1e-9);
  };

  const handleRuleChange = (ruleId: string) => {
    const rule = feeRules.find(r => r.id === ruleId);
    const amount = parseFloat(formData.amount) || 0;
    const autoFee = (feeMode === 'auto' && rule && amount > 0) ? String(calculateFee(rule, amount)) : formData.fee;
    setFormData({ ...formData, feeRuleId: ruleId, fee: autoFee });
  };

  const handleAmountChange = (amount: string) => {
    const amt = parseFloat(amount) || 0;
    const autoFee = (feeMode === 'auto' && selectedRule && amt > 0) ? String(calculateFee(selectedRule, amt)) : formData.fee;
    setFormData({ ...formData, amount: amount, fee: autoFee });
  };

  const openCreate = () => {
    setFormData({
      accountId: accounts.find(a => a.status === 'active')?.id || '', feeRuleId: '',
      amount: '', fee: '0', referenceNumber: '', description: '', customerName: '',
      transactionDate: localDateTimeValue(), feeAddedToBalance: true, notes: '', customerId: '', customerMode: 'select', customerPhone: '',
      providerCharge: '',
    });
    setCreateCharges([]);
    setFeeMode('auto');
    setShowModal(true);
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!formData.accountId) { setError('Please select an account'); return; }
    try {
      const validCharges = createCharges.filter(c => c.description.trim() && parseFloat(c.amount) > 0)
        .map(c => ({ description: c.description.trim(), amount: Math.round(parseFloat(c.amount) * 100) / 100 }));
      await api.post('/transactions', {
        accountId: formData.accountId,
        transactionTypeId: feeMode === 'manual' && selectedRule ? selectedRule.transaction_type_id : undefined,
        feeRuleId: feeMode === 'auto' ? (formData.feeRuleId || undefined) : undefined,
        manualFee: feeMode === 'manual',
        amount: parseFloat(formData.amount),
        fee: parseFloat(formData.fee),
        referenceNumber: formData.referenceNumber || undefined,
        description: formData.description || undefined,
        customerName: formData.customerName || undefined,
        customerContact: formData.customerMode === 'manual' ? formData.customerPhone : undefined,
        transactionDate: formData.transactionDate || undefined,
        feeAddedToBalance: formData.feeAddedToBalance,
        additionalCharges: validCharges.length > 0 ? validCharges : [],
        providerCharge: chargeApplies ? formData.providerCharge || undefined : undefined,
        notes: formData.notes || undefined,
        customerId: formData.customerMode === 'select' ? formData.customerId || undefined : undefined,
      });
      setShowModal(false);
      setFormData({ accountId: '', feeRuleId: '', amount: '', fee: '0', referenceNumber: '', description: '', customerName: '', transactionDate: localDateTimeValue(), feeAddedToBalance: true, notes: '', customerId: '', customerMode: 'select', customerPhone: '', providerCharge: '' });
      fetchTransactions(pagination.page);
      fetchSummary();
    } catch (err: any) { setError(err.message); }
  };

  const handleReverse = async (id: string) => {
    const reason = prompt('Reason for reversal:');
    if (!reason) return;
    try {
      await api.post(`/transactions/${id}/reverse`, { reason });
      if (isAdmin) {
        alert('Transaction reversed successfully.');
      } else {
        alert('Reversal request submitted. Waiting for admin approval.');
      }
      setShowDetail(null);
      fetchTransactions(pagination.page);
      fetchSummary();
    } catch (err: any) { alert(err.message); }
  };

  const openCharges = () => {
    if (showDetail) {
      if (editingCharges) {
        setEditingCharges(false);
      } else {
        setChargeItems((showDetail.additional_charges || []).map(c => ({ description: c.description, amount: String(c.amount) })));
        setEditingCharges(true);
      }
    }
  };

  const addCharge = () => setChargeItems([...chargeItems, { description: '', amount: '' }]);
  const removeCharge = (i: number) => setChargeItems(chargeItems.filter((_, idx) => idx !== i));
  const updateCharge = (i: number, field: string, value: string) => {
    const updated = [...chargeItems];
    (updated[i] as any)[field] = value;
    setChargeItems(updated);
  };

  const addPredefinedCharge = (chargeTypeId: string) => {
    const ct = chargeTypes.find(c => c.id === chargeTypeId);
    if (ct) {
      setCreateCharges([...createCharges, { description: ct.name, amount: String(ct.default_amount || '') }]);
    }
  };

  const saveCharges = async () => {
    if (!showDetail) return;
    const charges = chargeItems
      .filter(c => c.description.trim() && parseFloat(c.amount) > 0)
      .map(c => ({ description: c.description.trim(), amount: Math.round(parseFloat(c.amount) * 100) / 100 }));
    try {
      const result = await api.patch<Transaction>(`/transactions/${showDetail.id}/charges`, { additionalCharges: charges });
      setShowDetail({ ...showDetail, additional_charges: result.additional_charges });
      setEditingCharges(false);
      fetchTransactions(pagination.page);
      fetchSummary();
    } catch (err: any) { alert(err.message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Transactions</h2>
          <p className="text-sm text-gray-600">{pagination.total} transaction(s)</p>
        </div>
        <button onClick={openCreate} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Transaction
        </button>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="card py-3">
            <p className="text-xs text-gray-500">Money In</p>
            <p className="text-lg font-bold text-green-600">{formatCurrency(summary.totalMoneyIn)}</p>
          </div>
          <div className="card py-3">
            <p className="text-xs text-gray-500">Money Out</p>
            <p className="text-lg font-bold text-red-600">{formatCurrency(summary.totalMoneyOut)}</p>
          </div>
          <div className="card py-3">
            <p className="text-xs text-gray-500">Net Movement</p>
            <p className={`text-lg font-bold ${summary.netMovement >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(summary.netMovement)}</p>
          </div>
          <div className="card py-3">
            <p className="text-xs text-gray-500">Company Income</p>
            <p className="text-lg font-bold text-yellow-600">{formatCurrency(summary.totalFees)}</p>
          </div>
          <div className="card py-3">
            <p className="text-xs text-gray-500">Transactions</p>
            <p className="text-lg font-bold">{summary.transactionCount}</p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input type="text" placeholder="Search..." value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && fetchTransactions(1)}
            className="input pl-10" />
        </div>
        <select value={filters.accountId} onChange={(e) => setFilters({ ...filters, accountId: e.target.value })} className="input w-auto">
          <option value="">All Accounts</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {/* Operating expenses are transactions and land in this list like any
            other, so this filter is the only way to isolate them here. They
            are deliberately NOT removed from it: dropping the option would
            leave the rows visible but unfindable. What stops an expense being
            raised from this page is the fee-rule guard — no fee rule may carry
            a controlled type, and the type on a new transaction comes from the
            fee rule. */}
        <select value={filters.typeId} onChange={(e) => setFilters({ ...filters, typeId: e.target.value })} className="input w-auto">
          <option value="">All Types</option>
          {filterTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} className="input w-auto">
          <option value="">All Status</option>
          <option value="pending">Pending</option>
          <option value="completed">Completed</option>
          <option value="reversed">Reversed</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <input type="date" value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
          className="input w-auto" title="Start Date" />
        <input type="date" value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
          className="input w-auto" title="End Date" />
        <input type="number" placeholder="Min ₱" value={filters.minAmount} onChange={(e) => setFilters({ ...filters, minAmount: e.target.value })}
          className="input w-24" />
        <input type="number" placeholder="Max ₱" value={filters.maxAmount} onChange={(e) => setFilters({ ...filters, maxAmount: e.target.value })}
          className="input w-24" />
        <button onClick={() => fetchTransactions(1)} className="btn-secondary">Search</button>
        <button onClick={() => { setFilters({ search: '', typeId: '', status: '', accountId: '', startDate: '', endDate: '', minAmount: '', maxAmount: '' }); setTimeout(() => fetchTransactions(1), 0); }}
          className="btn-secondary text-gray-500">Clear</button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[1100px]">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Tx#</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Date</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Account</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Type</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Customer</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Reference</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Amount</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Fee</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Fee Handling</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Created By</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr><td colSpan={12} className="text-center py-8 text-gray-500">Loading...</td></tr>
            ) : transactions.length === 0 ? (
              <tr><td colSpan={12} className="text-center py-8 text-gray-500">No transactions found</td></tr>
            ) : (
              transactions.map((tx) => (
                <tr key={tx.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-mono">#{tx.transaction_number}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{new Date(tx.transaction_date).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-sm">{tx.account_name}</td>
                  <td className="px-4 py-3 text-sm">
                    <div className="flex items-center gap-1">
                      {tx.direction === 'in' ? <ArrowDownLeft className="w-4 h-4 text-green-500" /> : <ArrowUpRight className="w-4 h-4 text-red-500" />}
                      <span>{tx.type_name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {tx.customer_name ? (
                      <button onClick={() => fetchCustomerHistory(tx.customer_name!)} className="text-primary-600 hover:text-primary-700 hover:underline text-left">
                        {tx.customer_name}
                      </button>
                    ) : <span className="text-gray-400">-</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    <div className="max-w-[180px] truncate" title={tx.reference_number || undefined}>
                      {tx.reference_number || <span className="text-gray-400">-</span>}
                    </div>
                  </td>
                  <td className={`px-4 py-3 text-sm text-right font-medium ${tx.direction === 'in' ? 'text-green-600' : 'text-red-600'}`}>
                    {tx.direction === 'in' ? '+' : '-'}{formatCurrency(tx.amount)}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-500">{tx.fee > 0 ? formatCurrency(tx.fee) : '-'}</td>
                  <td className="px-4 py-3 text-center">
                    {tx.fee > 0 ? (
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${tx.fee_added_to_balance ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                        {tx.fee_added_to_balance ? 'Separate' : 'Deducted'}
                      </span>
                    ) : <span className="text-gray-400 text-xs">-</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`badge-${tx.status === 'completed' ? 'green' : tx.status === 'reversed' || tx.status === 'rejected' ? 'red' : 'yellow'}`}>{tx.status}</span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{tx.created_by_username || <span className="text-gray-400">-</span>}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => setShowDetail(tx)} className="p-1 text-gray-400 hover:text-primary-600"><Eye className="w-4 h-4" /></button>
                    {canEdit(tx) && (
                      <button onClick={() => openEdit(tx)} title="Edit transaction" className="p-1 text-gray-400 hover:text-primary-600"><Pencil className="w-4 h-4" /></button>
                    )}
                    {isAdmin && (
                      <button onClick={() => handleDelete(tx.id)} className="p-1 text-gray-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                    )}
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
            <button key={page} onClick={() => fetchTransactions(page)}
              className={`px-3 py-1 rounded-lg text-sm ${page === pagination.page ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
              {page}
            </button>
          ))}
        </div>
      )}

      {showDetail && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold">Transaction #{showDetail.transaction_number}</h3>
              <button onClick={() => setShowDetail(null)}><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-3">
              {showDetail.status === 'pending' && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded-lg text-sm">
                  Awaiting admin approval — the account balance has not changed yet.
                </div>
              )}
              {showDetail.status === 'rejected' && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">
                  Rejected{showDetail.rejection_reason ? `: ${showDetail.rejection_reason}` : ' — no money moved.'}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div><p className="text-xs text-gray-500">Account</p><p className="font-medium">{showDetail.account_name}</p></div>
                <div><p className="text-xs text-gray-500">Type</p><p className="font-medium">{showDetail.type_name}{showDetail.category_name ? ` / ${showDetail.category_name}` : ''}</p></div>
                <div><p className="text-xs text-gray-500">Amount</p><p className={`font-bold ${showDetail.direction === 'in' ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(showDetail.amount)}</p></div>
                <div><p className="text-xs text-gray-500">Fee (company income)</p><p className="font-medium text-yellow-600">{formatCurrency(showDetail.fee)}</p></div>
                {(showDetail.status === 'completed' || showDetail.status === 'reversed') && (
                  <div><p className="text-xs text-gray-500">Account Movement</p><p className="font-bold">{formatCurrency((showDetail.fee_added_to_balance ? showDetail.amount : showDetail.amount - showDetail.fee) + (showDetail.additional_charges || []).reduce((sum, c) => sum + c.amount, 0))}</p></div>
                )}
                <div><p className="text-xs text-gray-500">Status</p><p className="font-medium">{showDetail.status}</p></div>
                <div><p className="text-xs text-gray-500">Date</p><p className="font-medium">{new Date(showDetail.transaction_date).toLocaleString()}</p></div>
                <div><p className="text-xs text-gray-500">Reference</p><p className="font-medium">{showDetail.reference_number || '-'}</p></div>
                {showDetail.payment_method && <div><p className="text-xs text-gray-500">Method</p><p className="font-medium">{paymentMethodLabel(showDetail.payment_method)}</p></div>}
                {showDetail.customer_name && <div><p className="text-xs text-gray-500">Customer</p><p className="font-medium">{showDetail.customer_name}</p></div>}
              </div>
              {showDetail.description && <div><p className="text-xs text-gray-500">Description</p><p className="text-sm">{showDetail.description}</p></div>}

              <div className="border-t pt-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-medium text-gray-700">Additional Charges</p>
                  {showDetail.status === 'completed' && (
                    <button onClick={openCharges} className="text-xs text-primary-600 hover:text-primary-700">
                      {editingCharges ? 'Cancel' : 'Edit'}
                    </button>
                  )}
                </div>
                {editingCharges ? (
                  <div className="space-y-2">
                    {chargeItems.map((c, i) => (
                      <div key={i} className="flex gap-2 items-center">
                        <input type="text" value={c.description} onChange={e => updateCharge(i, 'description', e.target.value)}
                          className="input flex-1 text-xs py-1" placeholder="Description" />
                        <input type="number" step="0.01" min="0" value={c.amount} onChange={e => updateCharge(i, 'amount', e.target.value)}
                          className="input w-24 text-xs py-1" placeholder="Amount" />
                        <button onClick={() => removeCharge(i)} className="p-1 text-gray-400 hover:text-red-600">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    <button onClick={addCharge} className="text-xs text-primary-600 hover:text-primary-700 flex items-center gap-1">
                      <Plus className="w-3 h-3" /> Add Charge
                    </button>
                    <div className="flex justify-end pt-2">
                      <button onClick={saveCharges} className="btn-primary text-xs py-1">Save Charges</button>
                    </div>
                  </div>
                ) : (
                  <div>
                    {(showDetail.additional_charges || []).length === 0 ? (
                      <p className="text-xs text-gray-400 italic">No additional charges</p>
                    ) : (
                      <div className="space-y-1">
                        {showDetail.additional_charges.map((c, i) => (
                          <div key={i} className="flex justify-between text-xs">
                            <span className="text-gray-600">{c.description}</span>
                            <span className="font-medium">{formatCurrency(c.amount)}</span>
                          </div>
                        ))}
                        <div className="flex justify-between text-xs font-bold pt-1 border-t">
                          <span>Total Additional Charges</span>
                          <span>{formatCurrency(showDetail.additional_charges.reduce((sum, c) => sum + c.amount, 0))}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {showDetail.notes && (
                  <div className="pt-3 border-t">
                    <p className="text-xs text-gray-500 mb-1">Notes (Internal)</p>
                    <div className="flex gap-2">
                      <textarea
                        defaultValue={showDetail.notes}
                        onBlur={async (e) => {
                          const newNotes = e.target.value;
                          if (newNotes !== showDetail.notes) {
                            try {
                              const updated = await api.patch<{ notes: string | null }>(`/transactions/${showDetail.id}/notes`, { notes: newNotes });
                              setShowDetail({ ...showDetail, notes: updated.notes });
                            } catch (err) { console.error('Failed to update notes'); }
                          }
                        }}
                        className="input text-sm flex-1" rows={2}
                      />
                    </div>
                  </div>
                )}
                {!showDetail.notes && (
                  <div className="pt-3 border-t">
                    <button
                      onClick={async () => {
                        const notes = prompt('Add internal notes:');
                        if (notes !== null) {
                          try {
                            const updated = await api.patch<{ notes: string | null }>(`/transactions/${showDetail.id}/notes`, { notes });
                            setShowDetail({ ...showDetail, notes: updated.notes });
                          } catch (err) { console.error('Failed to add notes'); }
                        }
                      }}
                      className="text-xs text-primary-600 hover:text-primary-700"
                    >+ Add Notes</button>
                  </div>
                )}
              </div>

              {showDetail.status === 'completed' && showDetail.type_code !== 'adjustment_in' && showDetail.type_code !== 'adjustment_out' && (
                <div className="pt-3 border-t">
                  <button onClick={() => handleReverse(showDetail.id)} className="btn-secondary text-sm text-red-600">
                    {isAdmin ? 'Reverse Transaction' : 'Request Reversal'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-4xl max-h-[94vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold">New Transaction</h3>
              <button onClick={() => setShowModal(false)}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-4 space-y-3">
              {error && <div className="bg-red-50 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>}

              <div className="flex flex-col lg:flex-row gap-4">
                <div className="lg:w-1/2 space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Account *</label>
                    <AccountSelect
                      accounts={accounts.filter(a => a.status === 'active')}
                      value={formData.accountId}
                      onChange={(id) => setFormData({ ...formData, accountId: id })}
                      placeholder="Select account"
                      className="input text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Fee Rule *</label>
                    <select required value={formData.feeRuleId} onChange={(e) => handleRuleChange(e.target.value)} className="input text-sm">
                      <option value="">Select fee rule</option>
                      {feeRules.map(r => (
                        <option key={r.id} value={r.id}>
                          [{r.direction.toUpperCase()}] {r.type_name}{r.category_name ? ` / ${r.category_name}` : ''} &mdash; {r.name} ({r.calculation_method === 'per_amount' ? 'per amount' : r.fee_type === 'percentage' ? `${r.fee_value}%` : formatCurrency(r.fee_value)})
                        </option>
                      ))}
                    </select>
                    {selectedRule && (
                      <p className="text-xs text-gray-500 mt-1">
                        Type: {selectedRule.type_name}{selectedRule.category_name ? ` > ${selectedRule.category_name}` : ''} &bull; {selectedRule.tiers && selectedRule.tiers.length > 0 ? `${selectedRule.tiers.length} tier(s)${selectedRule.calculation_method === 'per_amount' ? ' · per amount' : ''}` : selectedRule.fee_type === 'flat_per_step' ? `${formatCurrency(selectedRule.fee_value)} + ${formatCurrency(selectedRule.step_fee)}/${formatCurrency(selectedRule.step_amount)}` : `Fee: ${selectedRule.fee_type === 'percentage' ? `${selectedRule.fee_value}%` : formatCurrency(selectedRule.fee_value)}`}
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
                      <input type="number" step="0.01" min="0" required value={formData.amount} onChange={(e) => handleAmountChange(e.target.value)} className="input text-sm" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Fee</label>
                      <input
                        type="number" step="0.01" min="0" required
                        value={formData.fee}
                        readOnly={feeMode === 'auto'}
                        onChange={(e) => setFormData({ ...formData, fee: e.target.value })}
                        className={`input text-sm ${feeMode === 'auto' ? 'bg-gray-50 text-gray-500 cursor-not-allowed' : 'bg-white'}`}
                        placeholder={feeMode === 'manual' ? 'Enter fee amount' : ''}
                      />
                    </div>
                    <div className="col-span-2">
                      <div className="flex flex-wrap gap-1">
                        {[100, 500, 1000, 5000, 10000].map(v => (
                          <button key={v} type="button" onClick={() => handleAmountChange(String(v))}
                            className="px-2 py-0.5 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-100">
                            {formatCurrency(v).replace(/\.00$/, '')}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <div className="flex items-center gap-2">
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" checked={formData.feeAddedToBalance} onChange={(e) => setFormData({ ...formData, feeAddedToBalance: e.target.checked })} className="sr-only peer" />
                        <div className="w-9 h-5 bg-gray-200 peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                      </label>
                      <span className="text-sm text-gray-700">Fee Handling</span>
                      <span className="text-xs text-gray-500">({formData.feeAddedToBalance ? 'Fee paid separately by customer' : 'Fee deducted from transaction amount'})</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" checked={feeMode === 'manual'} onChange={(e) => { const m = e.target.checked ? 'manual' : 'auto'; setFeeMode(m); if (m === 'auto' && selectedRule) { const amt = parseFloat(formData.amount) || 0; setFormData({ ...formData, fee: amt > 0 ? String(calculateFee(selectedRule, amt)) : '0' }); } }} className="sr-only peer" />
                        <div className="w-9 h-5 bg-gray-200 peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                      </label>
                      <span className="text-sm text-gray-700">Manual Fee</span>
                      <span className="text-xs text-gray-500">({feeMode === 'auto' ? 'Fee auto-calculated from rule' : 'You decide the fee amount'})</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Date &amp; Time *</label>
                      <input type="datetime-local" required value={formData.transactionDate} onChange={(e) => setFormData({ ...formData, transactionDate: e.target.value })} className="input text-sm" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Reference # *</label>
                      <input type="text" required value={formData.referenceNumber} onChange={(e) => setFormData({ ...formData, referenceNumber: e.target.value })} className="input text-sm" placeholder="Enter reference number" />
                    </div>
                  </div>
                </div>

                <div className="lg:flex-1 space-y-3">
                  {selectedRule && parseFloat(formData.amount) > 0 && (
                    <div className="p-3 bg-gray-50 rounded-lg text-sm space-y-1">
                      <div className="flex justify-between">
                        <span>Amount</span>
                        <span className="font-medium">{formatCurrency(inputAmount)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Fee (company income)</span>
                        <span className="font-medium text-yellow-600">{formatCurrency(feeAmount)}</span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span>Additional Charges</span>
                        <span className="font-medium text-orange-600 whitespace-nowrap">{formatCurrency(chargesTotal)}</span>
                      </div>
                      <p className="text-xs text-gray-500">Deducted from the account, not company income.</p>
                      <div className="flex justify-between border-t pt-1">
                        <span className="font-semibold">Total Fee</span>
                        <span className="font-semibold">{formatCurrency(feeAmount + chargesTotal)}</span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span>Account movement</span>
                        <span className={`font-bold ${selectedDirection === 'out' ? '' : 'text-green-600'}`}>
                          {selectedDirection === 'out' ? '-' : '+'}{formatCurrency(totalOutflow)}
                        </span>
                      </div>
                      {formData.feeAddedToBalance && selectedDirection === 'in' && (
                        <div className="flex justify-between gap-2">
                          <span className="font-semibold">Customer pays</span>
                          <span className="font-bold text-green-700">{formatCurrency(inputAmount + chargesTotal + feeAmount)}</span>
                        </div>
                      )}
                      <p className="text-xs text-gray-500 leading-relaxed">
                        Cash: {formatBreakdown(inputAmount)}{feeAmount >= 1 && <> &bull; Fee cash: {formatBreakdown(feeAmount)}</>}
                        {' '}&bull; {selectedDirection === 'out'
                          ? (formData.feeAddedToBalance ? 'movement = amount + charges' : 'movement = amount - fee + charges')
                          : 'credited to account'}
                        {createCharges.filter(c => (parseFloat(c.amount) || 0) > 0).map((c, i) => (
                          <span key={i}> &bull; {c.description || 'Charge'} {formatCurrency(parseFloat(c.amount) || 0)}</span>
                        ))}
                      </p>
                    </div>
                  )}
                  {selectedAccount && totalOutflow > 0 && (
                    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 rounded-lg text-sm ${hasInsufficientBalance ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
                      <span>{selectedAccount.name} &mdash; {formatCurrency(selectedAccount.current_balance)} &mdash; {movementLabel}</span>
                      {hasInsufficientBalance && <span className="font-semibold">(Insufficient balance)</span>}
                      {!hasInsufficientBalance && (
                        <span className="text-xs">
                          {selectedDirection === 'out'
                            ? (formData.feeAddedToBalance ? '(Fee + charges paid separately)' : '(Fee deducted from amount)')
                            : '(No balance required)'}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Customer Section */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-medium text-gray-700">Customer</label>
                      <div className="flex bg-gray-100 rounded-lg p-0.5">
                        <button type="button" onClick={() => setFormData({ ...formData, customerMode: 'select', customerId: '', customerName: '' })}
                          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${formData.customerMode === 'select' ? 'bg-white text-primary-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                          Select from List
                        </button>
                        <button type="button" onClick={() => setFormData({ ...formData, customerMode: 'manual', customerId: '', customerName: '' })}
                          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${formData.customerMode === 'manual' ? 'bg-white text-primary-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                          Type Manually
                        </button>
                      </div>
                    </div>
                    {formData.customerMode === 'select' ? (
                      <select value={formData.customerId} onChange={(e) => {
                        const cid = e.target.value;
                        const cust = customers.find(c => c.id === cid);
                        setFormData({ ...formData, customerId: cid, customerName: cust ? `${cust.first_name} ${cust.last_name}` : '' });
                      }} className="input text-sm">
                        <option value="">-- Select a customer --</option>
                        {customers.map(c => (
                          <option key={c.id} value={c.id}>{c.last_name}, {c.first_name} {c.phone ? `(📱 ${c.phone})` : ''}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        <input type="text" value={formData.customerName} onChange={(e) => setFormData({ ...formData, customerName: e.target.value })} className="input text-sm" placeholder="Customer name" />
                        <input type="tel" value={formData.customerPhone} onChange={(e) => setFormData({ ...formData, customerPhone: e.target.value })} className="input text-sm" placeholder="Mobile number" />
                      </div>
                    )}
                    {formData.customerMode === 'select' && formData.customerId && (
                      <p className="text-xs text-gray-500 mt-1">
                        {customers.find(c => c.id === formData.customerId)?.phone || 'No phone number on file'}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                    <textarea value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} className="input text-sm" rows={2} placeholder="Transaction description" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Notes (Internal)</label>
                    <textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} className="input text-sm" rows={2} placeholder="Internal notes (not visible to customer)" />
                  </div>
                </div>
              </div>

              {/* Additional Charges */}
              <div className="border-t pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <label className="text-sm font-medium text-gray-700">Additional Charges</label>
                  <div className="flex items-center gap-2">
                    {chargeTypes.length > 0 && (
                      <select onChange={e => { if (e.target.value) { addPredefinedCharge(e.target.value); e.target.value = ''; } }} className="input py-1 text-xs w-auto">
                        <option value="">+ Select charge type</option>
                        {chargeTypes.map(ct => (
                          <option key={ct.id} value={ct.id}>{ct.name} ({formatCurrency(ct.default_amount)})</option>
                        ))}
                      </select>
                    )}
                    <button type="button" onClick={() => setCreateCharges([...createCharges, { description: '', amount: '' }])}
                      className="text-xs text-primary-600 hover:text-primary-700 flex items-center gap-1">
                      <Plus className="w-3 h-3" /> Custom Charge
                    </button>
                  </div>
                </div>
                {createCharges.length > 0 && (
                  <div className="space-y-1.5">
                    {createCharges.map((c, i) => (
                      <div key={i} className="flex gap-2 items-center">
                        <input type="text" value={c.description} onChange={e => {
                          const updated = [...createCharges]; updated[i] = { ...updated[i], description: e.target.value }; setCreateCharges(updated);
                        }} className="input text-sm flex-1 py-1" placeholder="Charge description" />
                        <input type="number" step="0.01" min="0" value={c.amount} onChange={e => {
                          const updated = [...createCharges]; updated[i] = { ...updated[i], amount: e.target.value }; setCreateCharges(updated);
                        }} className="input text-sm w-28 py-1" placeholder="Amount" />
                        <button type="button" onClick={() => setCreateCharges(createCharges.filter((_, idx) => idx !== i))} className="p-1 text-gray-400 hover:text-red-600">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    <p className="text-[11px] text-gray-500">Total charges: {formatCurrency(createCharges.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0))}</p>
                  </div>
                )}
              </div>

              {chargeApplies && (
                <div className="border-t pt-3">
                  <label htmlFor="providerCharge" className="text-sm font-medium text-gray-700">Provider Charge</label>
                  <p className="text-[11px] text-gray-500 mt-0.5 mb-1.5">
                    Only when the provider deducted a fee from the account balance for this movement and did not
                    bill the customer for it. It is written as a separate linked <strong>Expense</strong> row: the
                    balance drops by this much with nothing credited in return, it shows in Cash Transactions, and it
                    totals on the Expense Report.
                  </p>
                  <input
                    id="providerCharge"
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.providerCharge}
                    onChange={(e) => setFormData({ ...formData, providerCharge: e.target.value })}
                    className="input text-sm w-40"
                    placeholder="0.00"
                  />
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed" disabled={!!hasInsufficientBalance || !formData.referenceNumber.trim()}>Create Transaction</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editTx && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-3xl max-h-[94vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b">
              <div>
                <h3 className="text-lg font-semibold">Edit Transaction #{editTx.transaction_number}</h3>
                <p className="text-xs text-gray-500">{editTx.account_name} &bull; {editTx.type_name}</p>
              </div>
              <button onClick={() => setEditTx(null)}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleEditSubmit} className="p-4 space-y-3">
              {editError && <div className="bg-red-50 text-red-700 px-3 py-2 rounded-lg text-sm">{editError}</div>}

              <div className="bg-blue-50 border border-blue-200 text-blue-800 px-3 py-2 rounded-lg text-xs">
                {editTx.status === 'pending'
                  ? 'This record is awaiting approval — no money has moved yet, so changes here do not affect any balance.'
                  : 'Completed transactions are locked. Open the record and use Request Reversal to correct a completed transaction.'}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Transaction Date *</label>
                  <input type="datetime-local" required value={editForm.transactionDate}
                    onChange={(e) => setEditForm({ ...editForm, transactionDate: e.target.value })} className="input text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Reference #</label>
                  <input type="text" value={editForm.referenceNumber}
                    onChange={(e) => setEditForm({ ...editForm, referenceNumber: e.target.value })} className="input text-sm" placeholder="Reference number" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
                  <input type="number" step="0.01" min="0" required value={editForm.amount}
                    onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })} className="input text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Fee *</label>
                  <input type="number" step="1" min="0" required value={editForm.fee}
                    onChange={(e) => setEditForm({ ...editForm, fee: e.target.value })} className="input text-sm" />
                  <p className="text-xs text-gray-500 mt-1">Rounds up to the next whole peso.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Customer</label>
                  <input type="text" value={editForm.customerName}
                    onChange={(e) => setEditForm({ ...editForm, customerName: e.target.value })} className="input text-sm" placeholder="Customer name" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Mobile Number</label>
                  <input type="tel" value={editForm.customerContact}
                    onChange={(e) => setEditForm({ ...editForm, customerContact: e.target.value })} className="input text-sm" placeholder="Mobile number" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Payment Method</label>
                  <select value={editForm.paymentMethod}
                    onChange={(e) => setEditForm({ ...editForm, paymentMethod: e.target.value })} className="input text-sm">
                    <option value="">-- None --</option>
                    {paymentMethodOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Fee Handling</label>
                  <div className="flex rounded-md border border-gray-300 overflow-hidden w-fit">
                    <button type="button" onClick={() => setEditForm({ ...editForm, feeAddedToBalance: true })}
                      className={`px-3 py-1 text-xs font-medium ${editForm.feeAddedToBalance ? 'bg-primary-600 text-white' : 'bg-white text-gray-500 hover:text-gray-700'}`}>
                      Separate
                    </button>
                    <button type="button" onClick={() => setEditForm({ ...editForm, feeAddedToBalance: false })}
                      className={`px-3 py-1 text-xs font-medium ${!editForm.feeAddedToBalance ? 'bg-primary-600 text-white' : 'bg-white text-gray-500 hover:text-gray-700'}`}>
                      Deducted
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Fee is company income either way. &quot;Deducted&quot; also removes it from the account movement.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                    className="input text-sm" rows={2} placeholder="Transaction description" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes (Internal)</label>
                  <textarea value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                    className="input text-sm" rows={2} placeholder="Internal notes (not visible to customer)" />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setEditTx(null)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed" disabled={editSaving}>
                  {editSaving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showCustomerHistory && customerHistory && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b">
              <div>
                <h3 className="text-lg font-semibold">Customer: {customerHistory.customerName}</h3>
                <p className="text-sm text-gray-500">{customerHistory.summary.totalTransactions} transaction(s) found</p>
              </div>
              <button onClick={() => { setShowCustomerHistory(false); setCustomerHistory(null); }}><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4">
              <div className="grid grid-cols-3 gap-4 mb-4">
                <div className="card py-3 text-center">
                  <p className="text-xs text-gray-500">Money In</p>
                  <p className="text-lg font-bold text-green-600">{formatCurrency(customerHistory.summary.totalMoneyIn)}</p>
                </div>
                <div className="card py-3 text-center">
                  <p className="text-xs text-gray-500">Money Out</p>
                  <p className="text-lg font-bold text-red-600">{formatCurrency(customerHistory.summary.totalMoneyOut)}</p>
                </div>
                <div className="card py-3 text-center">
                  <p className="text-xs text-gray-500">Total Income</p>
                  <p className="text-lg font-bold text-yellow-600">{formatCurrency(customerHistory.summary.totalFees)}</p>
                </div>
              </div>
              {customerHistory.transactions.length === 0 ? (
                <p className="text-center text-gray-500 py-8">No transactions found for this customer</p>
              ) : (
                <div className="space-y-2">
                  {customerHistory.transactions.map((tx) => (
                    <div key={tx.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100">
                      <div className="flex items-center gap-3">
                        {tx.direction === 'in' ? <ArrowDownLeft className="w-4 h-4 text-green-500" /> : <ArrowUpRight className="w-4 h-4 text-red-500" />}
                        <div>
                          <p className="text-sm font-medium">#{tx.transaction_number} — {tx.type_name}</p>
                          <p className="text-xs text-gray-500">{tx.account_name} • {new Date(tx.transaction_date).toLocaleDateString()}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-bold ${tx.direction === 'in' ? 'text-green-600' : 'text-red-600'}`}>
                          {tx.direction === 'in' ? '+' : '-'}{formatCurrency(tx.amount)}
                        </p>
                        <p className="text-xs text-gray-500">{tx.fee > 0 ? `Fee: ${formatCurrency(tx.fee)}` : ''}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
