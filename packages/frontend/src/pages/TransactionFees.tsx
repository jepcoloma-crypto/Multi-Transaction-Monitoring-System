import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { Plus, Edit2, Trash2, X, DollarSign, Percent, Layers } from 'lucide-react';

interface TransactionType { id: string; name: string; code: string; direction: string; }
interface TransactionCategory { id: string; name: string; code: string; transaction_type_id: string; direction: string; }
interface FeeTier { id?: string; minAmount: string; maxAmount: string; feeValue: string; feeType: string; }
interface FeeConfig {
  id: string; transaction_type_id: string; transaction_category_id: string | null; name: string; fee_type: string;
  fee_value: number; min_fee: number; max_fee: number | null;
  is_active: boolean; description: string | null;
  type_name: string; type_code: string; direction: string;
  category_name: string | null; category_code: string | null;
  base_amount: number; step_amount: number; step_fee: number;
  tiers?: { id: string; min_amount: number; max_amount: number | null; fee_value: number }[];
}

export default function TransactionFees() {
  const [fees, setFees] = useState<FeeConfig[]>([]);
  const [txTypes, setTxTypes] = useState<TransactionType[]>([]);
  const [txCategories, setTxCategories] = useState<TransactionCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<FeeConfig | null>(null);
  const [filter, setFilter] = useState('');
  const [form, setForm] = useState({
    transactionTypeId: '', transactionCategoryId: '', name: '', feeType: 'fixed', feeValue: '',
    minFee: '', maxFee: '', description: '', baseAmount: '', stepAmount: '', stepFee: '',
  });
  const [tiers, setTiers] = useState<FeeTier[]>([]);
  const [error, setError] = useState('');

  const loadData = async () => {
    try {
      const [f, t, c] = await Promise.all([
        api.get<FeeConfig[]>('/transaction-fees'),
        api.get<TransactionType[]>('/transaction-types/types'),
        api.get<TransactionCategory[]>('/transaction-types/categories'),
      ]);
      setFees(f);
      setTxTypes(t);
      setTxCategories(c);
    } catch (err: any) { console.error('TransactionFees load error:', err); } finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, []);

  const filteredCategories = txCategories.filter(c => !form.transactionTypeId || c.transaction_type_id === form.transactionTypeId);

  const openCreate = () => {
    setEditing(null);
    setForm({ transactionTypeId: '', transactionCategoryId: '', name: '', feeType: 'fixed', feeValue: '', minFee: '', maxFee: '', description: '', baseAmount: '', stepAmount: '', stepFee: '' });
    setTiers([]);
    setShowModal(true);
    setError('');
  };

  const openEdit = (fee: FeeConfig) => {
    setEditing(fee);
    setForm({
      transactionTypeId: fee.transaction_type_id, transactionCategoryId: fee.transaction_category_id || '',
      name: fee.name, feeType: fee.fee_type,
      feeValue: String(fee.fee_value), minFee: String(fee.min_fee || ''),
      maxFee: fee.max_fee ? String(fee.max_fee) : '', description: fee.description || '',
      baseAmount: String(fee.base_amount || ''), stepAmount: String(fee.step_amount || ''), stepFee: String(fee.step_fee || ''),
    });
    setTiers(fee.tiers?.map(t => ({
      minAmount: String(t.min_amount),
      maxAmount: t.max_amount !== null ? String(t.max_amount) : '',
      feeValue: String(t.fee_value),
      feeType: (t as any).fee_type || 'fixed',
    })) || []);
    setShowModal(true);
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const validTiers = tiers.filter(t => t.minAmount && t.feeValue);
      const body = {
        transactionTypeId: form.transactionTypeId,
        transactionCategoryId: form.transactionCategoryId || undefined,
        name: form.name, feeType: form.feeType, feeValue: parseFloat(form.feeValue),
        minFee: form.minFee ? parseFloat(form.minFee) : undefined,
        maxFee: form.maxFee ? parseFloat(form.maxFee) : undefined,
        description: form.description || undefined,
        baseAmount: form.baseAmount ? parseFloat(form.baseAmount) : undefined,
        stepAmount: form.stepAmount ? parseFloat(form.stepAmount) : undefined,
        stepFee: form.stepFee ? parseFloat(form.stepFee) : undefined,
        tiers: editing ? validTiers.map(t => ({
          minAmount: t.minAmount,
          maxAmount: t.maxAmount || undefined,
          feeValue: t.feeValue,
          feeType: t.feeType,
        })) : (validTiers.length > 0 ? validTiers.map(t => ({
          minAmount: t.minAmount,
          maxAmount: t.maxAmount || undefined,
          feeValue: t.feeValue,
          feeType: t.feeType,
        })) : undefined),
      };
      if (editing) {
        await api.put(`/transaction-fees/${editing.id}`, body);
      } else {
        await api.post('/transaction-fees', body);
      }
      setShowModal(false);
      loadData();
    } catch (err: any) { setError(err.message); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this fee configuration?')) return;
    try { await api.delete(`/transaction-fees/${id}`); loadData(); } catch (err: any) { alert(err.message); }
  };

  const handleToggle = async (fee: FeeConfig) => {
    try {
      await api.put(`/transaction-fees/${fee.id}`, { isActive: !fee.is_active });
      loadData();
    } catch (err) { console.error('TransactionFees toggle error:', err); }
  };

  const filtered = fees.filter(f =>
    !filter || f.direction === filter
  );

  const addTier = () => {
    setTiers([...tiers, { minAmount: '', maxAmount: '', feeValue: '', feeType: 'fixed' }]);
    if (tiers.length === 0) {
      setForm({ ...form, feeValue: '0' });
    }
  };

  const updateTier = (index: number, field: keyof FeeTier, value: string) => {
    const updated = [...tiers];
    updated[index] = { ...updated[index], [field]: value };
    setTiers(updated);
  };

  const removeTier = (index: number) => {
    setTiers(tiers.filter((_, i) => i !== index));
  };

  const grouped = filtered.reduce<Record<string, FeeConfig[]>>((acc, f) => {
    const key = f.type_name;
    if (!acc[key]) acc[key] = [];
    acc[key].push(f);
    return acc;
  }, {});

  const directionBadge = (d: string) => {
    if (d === 'in') return <span className="badge-green">IN</span>;
    if (d === 'out') return <span className="badge-red">OUT</span>;
    return <span className="badge-blue">{d}</span>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Transaction Fee Setup</h2>
          <p className="text-sm text-gray-600">Configure fees for each transaction type and category</p>
        </div>
        <button onClick={openCreate} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Fee Rule
        </button>
      </div>

      <div className="flex gap-2">
        <button onClick={() => setFilter('')} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${!filter ? 'bg-primary-100 text-primary-700' : 'text-gray-600 hover:bg-gray-100'}`}>All</button>
        <button onClick={() => setFilter('in')} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${filter === 'in' ? 'bg-green-100 text-green-700' : 'text-gray-600 hover:bg-gray-100'}`}>Income</button>
        <button onClick={() => setFilter('out')} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${filter === 'out' ? 'bg-red-100 text-red-700' : 'text-gray-600 hover:bg-gray-100'}`}>Expense</button>
      </div>

      {loading ? (
        <div className="card"><div className="text-center py-12 text-gray-500">Loading...</div></div>
      ) : Object.keys(grouped).length === 0 ? (
        <div className="card"><div className="text-center py-12 text-gray-500">
          <DollarSign className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p className="font-medium">No fee configurations</p>
          <p className="text-sm mt-1">Add a fee rule to auto-calculate fees on transactions</p>
        </div></div>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([typeName, typeFees]) => (
            <div key={typeName} className="card overflow-hidden">
              <div className="px-4 py-3 bg-gray-50 border-b flex items-center gap-2">
                <h3 className="font-medium text-gray-900">{typeName}</h3>
                {directionBadge(typeFees[0].direction)}
                <span className="text-sm text-gray-500">({typeFees.length} rule{typeFees.length > 1 ? 's' : ''})</span>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="text-xs text-gray-500 uppercase border-b">
                    <th className="text-left px-4 py-2">Rule Name</th>
                    <th className="text-left px-4 py-2">Category</th>
                    <th className="text-left px-4 py-2">Type</th>
                    <th className="text-right px-4 py-2">Value</th>
                    <th className="text-right px-4 py-2">Min</th>
                    <th className="text-right px-4 py-2">Max</th>
                    <th className="text-center px-4 py-2">Status</th>
                    <th className="text-right px-4 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {typeFees.map(fee => (
                    <tr key={fee.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{fee.name}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{fee.category_name || <span className="text-gray-400 italic">All categories</span>}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-sm">
                          {fee.fee_type === 'percentage' ? <Percent className="w-3 h-3" /> : <DollarSign className="w-3 h-3" />}
                          {fee.fee_type === 'percentage' ? 'Percentage' : fee.fee_type === 'flat_per_step' ? 'Flat + Per Step' : 'Fixed'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-medium">
                        {fee.fee_type === 'flat_per_step'
                          ? `${formatCurrency(fee.fee_value)} + ${formatCurrency(fee.step_fee)}/${formatCurrency(fee.step_amount)}`
                          : fee.fee_type === 'percentage' ? `${fee.fee_value}%` : formatCurrency(fee.fee_value)}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-500">
                        {fee.min_fee > 0 ? (fee.fee_type === 'percentage' ? `${fee.min_fee}%` : formatCurrency(fee.min_fee)) : '-'}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-500">
                        {fee.max_fee ? (fee.fee_type === 'percentage' ? `${fee.max_fee}%` : formatCurrency(fee.max_fee)) : '-'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button onClick={() => handleToggle(fee)} className={`inline-flex px-2 py-1 rounded-full text-xs font-medium cursor-pointer ${fee.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                          {fee.is_active ? 'Active' : 'Inactive'}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => openEdit(fee)} className="p-1 text-gray-400 hover:text-primary-600"><Edit2 className="w-4 h-4" /></button>
                          <button onClick={() => handleDelete(fee.id)} className="p-1 text-gray-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {typeFees.some(f => f.tiers && f.tiers.length > 0) && (
                    <tr>
                      <td colSpan={8} className="px-4 py-3">
                        <div className="text-xs text-gray-500 mb-1 flex items-center gap-1"><Layers className="w-3 h-3" /> Tiered Rules</div>
                        {typeFees.filter(f => f.tiers && f.tiers.length > 0).map(fee => (
                          <div key={fee.id} className="ml-4 mb-2">
                            <p className="text-xs font-medium text-gray-700">{fee.name}:</p>
                            {fee.tiers!.map((tier, i) => (
                              <p key={i} className="text-xs text-gray-600 ml-2">
                                {formatCurrency(tier.min_amount)}{tier.max_amount ? ` - ${formatCurrency(tier.max_amount)}` : '+'} → {(tier as any).fee_type === 'percentage' ? `${tier.fee_value}%` : formatCurrency(tier.fee_value)}
                              </p>
                            ))}
                          </div>
                        ))}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
              <h3 className="text-base font-semibold">{editing ? 'Edit Fee Rule' : 'Add Fee Rule'}</h3>
              <button onClick={() => setShowModal(false)}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto flex-1">
              {error && <div className="bg-red-50 text-red-700 px-3 py-1.5 rounded text-xs">{error}</div>}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="form-label text-xs">Transaction Type *</label>
                  <select required value={form.transactionTypeId} onChange={e => setForm({ ...form, transactionTypeId: e.target.value, transactionCategoryId: '' })} className="input py-1.5 text-xs" disabled={!!editing}>
                    <option value="">Select type</option>
                    {txTypes.map(t => <option key={t.id} value={t.id}>[{t.direction.toUpperCase()}] {t.name}</option>)}
                  </select>
                </div>
                {filteredCategories.length > 0 && (
                  <div>
                    <label className="form-label text-xs">Category</label>
                    <select value={form.transactionCategoryId} onChange={e => setForm({ ...form, transactionCategoryId: e.target.value })} className="input py-1.5 text-xs">
                      <option value="">All categories</option>
                      {filteredCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="form-label text-xs">Rule Name *</label>
                  <input type="text" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="input py-1.5 text-xs" placeholder="e.g., GCash Service Fee" />
                </div>
                <div>
                  <label className="form-label text-xs">Description</label>
                  <input type="text" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} className="input py-1.5 text-xs" placeholder="Optional" />
                </div>
              </div>

              {tiers.length === 0 && (
                <>
                  <div className="flex items-end gap-3">
                    <div className="w-36">
                      <label className="form-label text-xs">Fee Type *</label>
                      <select value={form.feeType} onChange={e => setForm({ ...form, feeType: e.target.value })} className="input py-1.5 text-xs">
                        <option value="fixed">Fixed</option>
                        <option value="percentage">%</option>
                        <option value="flat_per_step">Flat + Per Step</option>
                      </select>
                    </div>
                    {form.feeType !== 'flat_per_step' ? (
                      <div className="w-28">
                        <label className="form-label text-xs">Fee Value *</label>
                        <input type="number" step="0.01" min="0" required value={form.feeValue} onChange={e => setForm({ ...form, feeValue: e.target.value })} className="input py-1.5 text-xs" placeholder={form.feeType === 'percentage' ? 'e.g. 2.5' : 'e.g. 15'} />
                      </div>
                    ) : (
                      <div className="w-28">
                        <label className="form-label text-xs">Base Fee *</label>
                        <input type="number" step="0.01" min="0" required value={form.feeValue} onChange={e => setForm({ ...form, feeValue: e.target.value })} className="input py-1.5 text-xs" placeholder="e.g. 30" />
                      </div>
                    )}
                    <div className="w-24">
                      <label className="form-label text-xs">Min Fee</label>
                      <input type="number" step="0.01" min="0" value={form.minFee} onChange={e => setForm({ ...form, minFee: e.target.value })} className="input py-1.5 text-xs" placeholder="Min" />
                    </div>
                    <div className="w-24">
                      <label className="form-label text-xs">Max Fee</label>
                      <input type="number" step="0.01" min="0" value={form.maxFee} onChange={e => setForm({ ...form, maxFee: e.target.value })} className="input py-1.5 text-xs" placeholder="Max" />
                    </div>
                  </div>
                  {form.feeType === 'flat_per_step' && (
                    <div className="flex items-end gap-3 bg-blue-50 border border-blue-200 rounded px-3 py-2">
                      <div className="w-36">
                        <label className="form-label text-xs">Base Amount *</label>
                        <input type="number" step="0.01" min="0" required value={form.baseAmount} onChange={e => setForm({ ...form, baseAmount: e.target.value })} className="input py-1.5 text-xs" placeholder="e.g. 3000" />
                      </div>
                      <div className="w-36">
                        <label className="form-label text-xs">Step Amount *</label>
                        <input type="number" step="0.01" min="0" required value={form.stepAmount} onChange={e => setForm({ ...form, stepAmount: e.target.value })} className="input py-1.5 text-xs" placeholder="e.g. 1000" />
                      </div>
                      <div className="w-28">
                        <label className="form-label text-xs">Step Fee *</label>
                        <input type="number" step="0.01" min="0" required value={form.stepFee} onChange={e => setForm({ ...form, stepFee: e.target.value })} className="input py-1.5 text-xs" placeholder="e.g. 10" />
                      </div>
                      <p className="text-[11px] text-blue-600">Base fee: {formatCurrency(parseFloat(form.feeValue) || 0)} + {formatCurrency(parseFloat(form.stepFee) || 0)} per {formatCurrency(parseFloat(form.stepAmount) || 0)} above {formatCurrency(parseFloat(form.baseAmount) || 0)}</p>
                    </div>
                  )}
                </>
              )}

              {tiers.length > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded px-3 py-1.5 text-xs text-blue-700">
                  Fee type and value are determined by tiered rules below.
                </div>
              )}

              <div className="border-t pt-3">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-medium text-gray-700 flex items-center gap-1"><Layers className="w-3.5 h-3.5" /> Tiered Fees</label>
                  <button type="button" onClick={addTier} className="text-xs text-primary-600 hover:text-primary-700 flex items-center gap-1">
                    <Plus className="w-3 h-3" /> Add Tier
                  </button>
                </div>
                <p className="text-[11px] text-gray-500 mb-2">If no tiers set, base fee applies to all amounts.</p>
                {tiers.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="grid grid-cols-12 gap-1.5 text-[11px] font-medium text-gray-500">
                      <div className="col-span-2">Min</div>
                      <div className="col-span-2">Max</div>
                      <div className="col-span-2">Type</div>
                      <div className="col-span-5">Value</div>
                      <div></div>
                    </div>
                    {tiers.map((tier, i) => (
                      <div key={i} className="grid grid-cols-12 gap-1.5 items-center">
                        <input type="number" step="0.01" min="0" value={tier.minAmount} onChange={e => updateTier(i, 'minAmount', e.target.value)}
                          className="input col-span-2 py-1 text-xs" placeholder="0" />
                        <input type="number" step="0.01" min="0" value={tier.maxAmount} onChange={e => updateTier(i, 'maxAmount', e.target.value)}
                          className="input col-span-2 py-1 text-xs" placeholder="∞" />
                        <select value={tier.feeType} onChange={e => updateTier(i, 'feeType', e.target.value)}
                          className="input col-span-2 py-1 text-xs">
                          <option value="fixed">Fixed</option>
                          <option value="percentage">%</option>
                        </select>
                        <input type="number" step="0.01" min="0" value={tier.feeValue} onChange={e => updateTier(i, 'feeValue', e.target.value)}
                          className="input col-span-5 py-1 text-xs" placeholder={tier.feeType === 'percentage' ? 'e.g. 1' : 'e.g. 5'} />
                        <button type="button" onClick={() => removeTier(i)} className="p-0.5 text-gray-400 hover:text-red-600 flex justify-center">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary text-xs py-1.5">Cancel</button>
                <button type="submit" className="btn-primary text-xs py-1.5">{editing ? 'Update' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
