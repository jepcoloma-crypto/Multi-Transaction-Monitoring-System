import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Plus, Edit2, Trash2, X } from 'lucide-react';

interface Provider {
  id: string;
  name: string;
  code: string;
  type: string;
  convenience_fee: number;
  is_active: boolean;
  notes: string | null;
  created_at: string;
}

export default function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [formData, setFormData] = useState({ name: '', code: '', type: 'e-wallet', convenienceFee: '', notes: '' });
  const [error, setError] = useState('');

  const fetchProviders = async () => {
    setLoading(true);
    try {
      const result = await api.get<Provider[]>('/providers');
      setProviders(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProviders(); }, []);

  const openCreate = () => {
    setEditingProvider(null);
    setFormData({ name: '', code: '', type: 'e-wallet', convenienceFee: '', notes: '' });
    setShowModal(true);
    setError('');
  };

  const openEdit = (provider: Provider) => {
    setEditingProvider(provider);
    setFormData({ name: provider.name, code: provider.code, type: provider.type, convenienceFee: String(provider.convenience_fee || 0), notes: provider.notes || '' });
    setShowModal(true);
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (editingProvider) {
        await api.put(`/providers/${editingProvider.id}`, formData);
      } else {
        await api.post('/providers', formData);
      }
      setShowModal(false);
      fetchProviders();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this provider?')) return;
    try {
      await api.delete(`/providers/${id}`);
      fetchProviders();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const getTypeBadge = (type: string) => {
    const map: Record<string, string> = { 'e-wallet': 'badge-blue', bank: 'badge-green', telecom: 'badge-yellow' };
    return map[type] || 'badge-gray';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Providers</h2>
          <p className="text-sm text-gray-600">{providers.length} provider(s)</p>
        </div>
        <button onClick={openCreate} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Provider
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading ? (
          <div className="col-span-full text-center py-8 text-gray-500">Loading...</div>
        ) : providers.length === 0 ? (
          <div className="col-span-full text-center py-8 text-gray-500">No providers found</div>
        ) : (
          providers.map((provider) => (
            <div key={provider.id} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-medium text-gray-900">{provider.name}</h3>
                  <p className="text-sm text-gray-500">{provider.code}</p>
                </div>
                <div className="flex gap-1">
                  <span className={getTypeBadge(provider.type)}>{provider.type}</span>
                  <button onClick={() => openEdit(provider)} className="p-1 text-gray-400 hover:text-primary-600">
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete(provider.id)} className="p-1 text-gray-400 hover:text-red-600">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="mt-2">
                <span className={provider.is_active ? 'badge-green' : 'badge-red'}>
                  {provider.is_active ? 'Active' : 'Inactive'}
                </span>
                {provider.convenience_fee > 0 && (
                  <span className="ml-2 text-xs text-orange-600">Conv. Fee: ₱{provider.convenience_fee}</span>
                )}
              </div>
              {provider.notes && <p className="text-xs text-gray-500 mt-2">{provider.notes}</p>}
            </div>
          ))
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-md">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold">{editingProvider ? 'Edit Provider' : 'Add Provider'}</h3>
              <button onClick={() => setShowModal(false)}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-4 space-y-4">
              {error && <div className="bg-red-50 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input type="text" required value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className="input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Code</label>
                <input type="text" required value={formData.code} onChange={(e) => setFormData({ ...formData, code: e.target.value.toLowerCase() })} className="input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                <select value={formData.type} onChange={(e) => setFormData({ ...formData, type: e.target.value })} className="input">
                  <option value="e-wallet">E-Wallet</option>
                  <option value="bank">Bank</option>
                  <option value="telecom">Telecom</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Convenience Fee (per load transaction)</label>
                <input type="number" step="0.01" min="0" value={formData.convenienceFee} onChange={(e) => setFormData({ ...formData, convenienceFee: e.target.value })} className="input" placeholder="0.00" />
                <p className="text-xs text-gray-500 mt-1">Fee charged by provider to operator (deducted from balance)</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} className="input" rows={2} />
              </div>
              <div className="flex justify-end gap-2 pt-4">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">{editingProvider ? 'Update' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
