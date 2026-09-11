import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Plus, Edit2, Trash2, X } from 'lucide-react';

interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  created_at: string;
}

interface Permission {
  id: string;
  name: string;
  description: string;
}

export default function Roles() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [formData, setFormData] = useState({ name: '', description: '', permissionIds: [] as string[] });
  const [error, setError] = useState('');

  const fetchRoles = async () => {
    setLoading(true);
    try {
      const result = await api.get<Role[]>('/roles');
      setRoles(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchPermissions = async () => {
    try {
      const result = await api.get<Permission[]>('/permissions');
      setPermissions(result);
    } catch (err) { console.error('Roles permissions load error:', err); }
  };

  useEffect(() => {
    fetchRoles();
    fetchPermissions();
  }, []);

  const openCreate = () => {
    setEditingRole(null);
    setFormData({ name: '', description: '', permissionIds: [] });
    setShowModal(true);
    setError('');
  };

  const openEdit = (role: Role) => {
    setEditingRole(role);
    setFormData({
      name: role.name,
      description: role.description || '',
      permissionIds: [],
    });
    setShowModal(true);
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (editingRole) {
        await api.put(`/roles/${editingRole.id}`, {
          name: formData.name,
          description: formData.description,
          permissionIds: formData.permissionIds,
        });
      } else {
        await api.post('/roles', {
          name: formData.name,
          description: formData.description,
          permissionIds: formData.permissionIds,
        });
      }
      setShowModal(false);
      fetchRoles();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDelete = async (roleId: string) => {
    if (!confirm('Are you sure you want to delete this role?')) return;
    try {
      await api.delete(`/roles/${roleId}`);
      fetchRoles();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const togglePermission = (permId: string) => {
    setFormData((prev) => ({
      ...prev,
      permissionIds: prev.permissionIds.includes(permId)
        ? prev.permissionIds.filter((id) => id !== permId)
        : [...prev.permissionIds, permId],
    }));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Roles</h2>
          <p className="text-sm text-gray-600">{roles.length} role(s) total</p>
        </div>
        <button onClick={openCreate} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Role
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading ? (
          <div className="col-span-full text-center py-8 text-gray-500">Loading...</div>
        ) : roles.length === 0 ? (
          <div className="col-span-full text-center py-8 text-gray-500">No roles found</div>
        ) : (
          roles.map((role) => (
            <div key={role.id} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-medium text-gray-900">{role.name}</h3>
                  {role.description && <p className="text-sm text-gray-500 mt-1">{role.description}</p>}
                </div>
                <div className="flex gap-1">
                  <button onClick={() => openEdit(role)} className="p-1 text-gray-400 hover:text-primary-600">
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete(role.id)} className="p-1 text-gray-400 hover:text-red-600">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {role.permissions && role.permissions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {role.permissions.slice(0, 5).map((p) => (
                    <span key={p} className="badge-gray">{p}</span>
                  ))}
                  {role.permissions.length > 5 && (
                    <span className="badge-gray">+{role.permissions.length - 5} more</span>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-lg max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold">{editingRole ? 'Edit Role' : 'Create Role'}</h3>
              <button onClick={() => setShowModal(false)}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-4 space-y-4">
              {error && <div className="bg-red-50 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input type="text" required value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className="input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} className="input" rows={2} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Permissions</label>
                <div className="grid grid-cols-2 gap-2 max-h-60 overflow-y-auto border rounded-lg p-3">
                  {permissions.map((perm) => (
                    <label key={perm.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={formData.permissionIds.includes(perm.id)}
                        onChange={() => togglePermission(perm.id)}
                        className="rounded border-gray-300 text-primary-600"
                      />
                      <span className="text-sm text-gray-700">{perm.name}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-4">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">{editingRole ? 'Update' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
