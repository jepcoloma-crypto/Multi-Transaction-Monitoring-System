import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Plus, Edit2, X, Building2, EyeOff, Eye } from 'lucide-react';

interface Branch {
  id: string;
  code: string;
  name: string;
  status: string;
  account_count: number;
  user_count: number;
  created_at: string;
}

export default function Branches() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [formData, setFormData] = useState({ code: '', name: '', status: 'active' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchBranches = async () => {
    setLoading(true);
    try {
      const result = await api.get<Branch[]>('/branches');
      setBranches(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBranches();
  }, []);

  const openCreate = () => {
    setEditing(null);
    setFormData({ code: '', name: '', status: 'active' });
    setError('');
    setShowModal(true);
  };

  const openEdit = (branch: Branch) => {
    setEditing(branch);
    setFormData({ code: branch.code, name: branch.name, status: branch.status });
    setError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      if (editing) {
        // Code is deliberately not sent: it is an identifier the rest of the
        // system may already be quoted in exports and audit entries, and the
        // API only accepts name and status on update.
        await api.put(`/branches/${editing.id}`, {
          name: formData.name,
          status: formData.status,
        });
      } else {
        await api.post('/branches', {
          code: formData.code,
          name: formData.name,
          status: formData.status,
        });
      }
      setShowModal(false);
      fetchBranches();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (branch: Branch) => {
    const next = branch.status === 'active' ? 'inactive' : 'active';
    if (next === 'inactive' && branch.account_count > 0) {
      const confirmed = confirm(
        `${branch.name} still holds ${branch.account_count} account(s).\n\n` +
          'Deactivating stops the branch being offered for new assignments and new users. ' +
          'Existing accounts, balances and history stay exactly where they are.\n\nContinue?',
      );
      if (!confirmed) return;
    }
    try {
      await api.put(`/branches/${branch.id}`, { status: next });
      fetchBranches();
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Branches</h2>
          <p className="text-sm text-gray-600">
            {branches.length} branch(es) total · accounts and users are assigned to exactly one
            branch each
          </p>
        </div>
        <button onClick={openCreate} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Branch
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading ? (
          <div className="col-span-full text-center py-8 text-gray-500">Loading...</div>
        ) : branches.length === 0 ? (
          <div className="col-span-full text-center py-8 text-gray-500">No branches found</div>
        ) : (
          branches.map((branch) => (
            <div key={branch.id} className="card">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-lg bg-primary-50 text-primary-600 flex items-center justify-center shrink-0">
                    <Building2 className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-gray-900">{branch.name}</h3>
                      {branch.status !== 'active' && (
                        <span className="badge-gray bg-gray-100 text-gray-500">Inactive</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5 font-mono">{branch.code}</p>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => openEdit(branch)}
                    className="p-1 text-gray-400 hover:text-primary-600"
                    title="Edit branch"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleToggle(branch)}
                    className={`p-1 ${branch.status === 'active' ? 'text-gray-400 hover:text-red-600' : 'text-gray-400 hover:text-green-600'}`}
                    title={branch.status === 'active' ? 'Deactivate branch' : 'Reactivate branch'}
                  >
                    {branch.status === 'active' ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-gray-50 px-3 py-2">
                  <div className="text-lg font-semibold text-gray-900">{branch.account_count}</div>
                  <div className="text-xs text-gray-500">Account(s)</div>
                </div>
                <div className="rounded-lg bg-gray-50 px-3 py-2">
                  <div className="text-lg font-semibold text-gray-900">{branch.user_count}</div>
                  <div className="text-xs text-gray-500">Active user(s)</div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-lg">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold">{editing ? 'Edit Branch' : 'Create Branch'}</h3>
              <button onClick={() => setShowModal(false)}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-4 space-y-4">
              {error && (
                <div className="bg-red-50 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Code</label>
                <input
                  type="text"
                  required
                  disabled={Boolean(editing)}
                  maxLength={20}
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                  className="input disabled:bg-gray-50 disabled:text-gray-500"
                  placeholder="e.g., MAIN, NORTH"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {editing
                    ? 'The code cannot be changed once the branch exists.'
                    : 'Short identifier shown in exports. Cannot be changed later.'}
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input
                  type="text"
                  required
                  maxLength={100}
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="input"
                  placeholder="e.g., Main Branch"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                  className="input"
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Inactive branches stay assigned to the accounts that already use them; they are
                  simply no longer offered for new assignments.
                </p>
              </div>
              <div className="flex justify-end gap-2 pt-4">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={saving}>
                  {saving ? 'Saving...' : editing ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
