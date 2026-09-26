import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { Plus, Edit2, Trash2, X } from 'lucide-react';

interface Provider {
  id: string;
  name: string;
}

interface ProviderCharge {
  id: string;
  name: string;
  description: string | null;
  charge_amount: number;
  is_active: boolean;
  source_provider_id: string | null;
  destination_provider_id: string | null;
  source_provider_name: string | null;
  destination_provider_name: string | null;
}

const emptyForm = {
  name: '',
  sourceProviderId: '',
  destinationProviderId: '',
  chargeAmount: '',
  description: '',
  isActive: true,
};

export default function ProviderCharges() {
  const [charges, setCharges] = useState<ProviderCharge[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<ProviderCharge | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [c, p] = await Promise.all([
        api.get<ProviderCharge[]>('/provider-charges'),
        api.get<Provider[]>('/providers'),
      ]);
      setCharges(c);
      setProviders(p);
    } catch (err) { console.error(err); } finally { setLoading(false); }
  };

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowModal(true);
    setError('');
  };

  const openEdit = (charge: ProviderCharge) => {
    setEditing(charge);
    setForm({
      name: charge.name,
      sourceProviderId: charge.source_provider_id || '',
      destinationProviderId: charge.destination_provider_id || '',
      chargeAmount: String(charge.charge_amount),
      description: charge.description || '',
      isActive: charge.is_active,
    });
    setShowModal(true);
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const body = {
        name: form.name,
        sourceProviderId: form.sourceProviderId || null,
        destinationProviderId: form.destinationProviderId || null,
        chargeAmount: parseFloat(form.chargeAmount) || 0,
        description: form.description || undefined,
        isActive: form.isActive,
      };
      if (editing) {
        await api.put(`/provider-charges/${editing.id}`, body);
      } else {
        await api.post('/provider-charges', body);
      }
      setShowModal(false);
      fetchData();
    } catch (err: any) { setError(err.message); }
  };

  const handleToggle = async (charge: ProviderCharge) => {
    try {
      await api.patch(`/provider-charges/${charge.id}/toggle`, {});
      fetchData();
    } catch (err: any) { alert(err.message); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this provider charge rule?')) return;
    try {
      await api.delete(`/provider-charges/${id}`);
      fetchData();
    } catch (err: any) { alert(err.message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Provider Charges</h2>
          <p className="text-sm text-gray-600">Service charges applied to fund transfers between providers</p>
        </div>
        <button onClick={openCreate} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Charge Rule
        </button>
      </div>

      <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-sm text-blue-800">
        Rules match a transfer's source and destination provider. Leave a side as <strong>Any provider</strong> to match everything.
        When several rules match, the most specific wins: exact pair → one-sided rule → global default.
      </div>

      {loading ? (
        <div className="text-center py-8 text-gray-500">Loading...</div>
      ) : charges.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500">No provider charge rules yet</p>
          <button onClick={openCreate} className="btn-primary mt-4">Add First Charge Rule</button>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="text-xs text-gray-500 uppercase bg-gray-50 border-b">
                <th className="text-left px-4 py-3">Name</th>
                <th className="text-left px-4 py-3">From</th>
                <th className="text-left px-4 py-3">To</th>
                <th className="text-right px-4 py-3">Charge</th>
                <th className="text-left px-4 py-3">Description</th>
                <th className="text-center px-4 py-3">Status</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {charges.map(charge => (
                <tr key={charge.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{charge.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {charge.source_provider_name || <span className="text-gray-400">Any provider</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {charge.destination_provider_name || <span className="text-gray-400">Any provider</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-medium">{formatCurrency(charge.charge_amount)}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{charge.description || '-'}</td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => handleToggle(charge)} className={`inline-flex px-2 py-1 rounded-full text-xs font-medium cursor-pointer ${charge.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {charge.is_active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => openEdit(charge)} className="p-1 text-gray-400 hover:text-primary-600"><Edit2 className="w-4 h-4" /></button>
                      <button onClick={() => handleDelete(charge.id)} className="p-1 text-gray-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-md">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold">{editing ? 'Edit Charge Rule' : 'Add Charge Rule'}</h3>
              <button onClick={() => setShowModal(false)}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-4 space-y-4">
              {error && <div className="bg-red-50 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>}
              <div>
                <label className="form-label">Name *</label>
                <input type="text" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="input" placeholder="e.g., GCash to BDO" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="form-label">From Provider</label>
                  <select value={form.sourceProviderId} onChange={e => setForm({ ...form, sourceProviderId: e.target.value })} className="input">
                    <option value="">Any provider</option>
                    {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="form-label">To Provider</label>
                  <select value={form.destinationProviderId} onChange={e => setForm({ ...form, destinationProviderId: e.target.value })} className="input">
                    <option value="">Any provider</option>
                    {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="form-label">Charge Amount *</label>
                <input type="number" step="0.01" min="0" required value={form.chargeAmount} onChange={e => setForm({ ...form, chargeAmount: e.target.value })} className="input" placeholder="0.00" />
                <p className="text-xs text-gray-500 mt-1">Deducted from the source account when this rule matches</p>
              </div>
              <div>
                <label className="form-label">Description</label>
                <input type="text" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} className="input" placeholder="Optional" />
              </div>
              <div className="flex items-center gap-3">
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} className="sr-only peer" />
                  <div className="w-9 h-5 bg-gray-200 peer-focus:ring-2 peer-focus:ring-primary-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                </label>
                <span className="text-sm text-gray-700">Active</span>
              </div>
              <div className="flex justify-end gap-2 pt-4">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">{editing ? 'Update' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
