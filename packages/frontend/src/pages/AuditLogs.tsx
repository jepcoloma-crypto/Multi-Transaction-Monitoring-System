import { useState, useEffect } from 'react';
import { api } from '../lib/api';

interface AuditLog {
  id: string;
  user_id: string;
  action: string;
  entity: string;
  entity_id: string | null;
  ip_address: string | null;
  old_data: any;
  new_data: any;
  reason: string | null;
  created_at: string;
  user_email: string;
  first_name: string;
  last_name: string;
}

export default function AuditLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [filters, setFilters] = useState({ action: '', entity: '' });

  const fetchLogs = async (page = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (filters.action) params.set('action', filters.action);
      if (filters.entity) params.set('entity', filters.entity);
      const result = await api.get<{ data: AuditLog[]; pagination: any }>(`/audit-logs?${params}`);
      setLogs(result.data);
      setPagination(result.pagination);
    } catch {
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, []);

  const getActionBadge = (action: string) => {
    if (action.includes('login') || action.includes('logout')) return 'badge-blue';
    if (action.includes('created')) return 'badge-green';
    if (action.includes('updated') || action.includes('changed')) return 'badge-yellow';
    if (action.includes('deleted') || action.includes('deactivated')) return 'badge-red';
    return 'badge-gray';
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Audit Logs</h2>
        <p className="text-sm text-gray-600">{pagination.total} log(s) total</p>
      </div>

      <div className="flex gap-2">
        <select
          value={filters.action}
          onChange={(e) => setFilters({ ...filters, action: e.target.value })}
          className="input w-auto"
        >
          <option value="">All Actions</option>
          <option value="auth.login">Login</option>
          <option value="auth.logout">Logout</option>
          <option value="user.created">User Created</option>
          <option value="user.updated">User Updated</option>
          <option value="user.deactivated">User Deactivated</option>
          <option value="user.password_changed">Password Changed</option>
          <option value="role.created">Role Created</option>
          <option value="role.updated">Role Updated</option>
          <option value="role.deleted">Role Deleted</option>
        </select>
        <select
          value={filters.entity}
          onChange={(e) => setFilters({ ...filters, entity: e.target.value })}
          className="input w-auto"
        >
          <option value="">All Entities</option>
          <option value="user">User</option>
          <option value="role">Role</option>
        </select>
        <button onClick={() => fetchLogs(1)} className="btn-secondary">Filter</button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Timestamp</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">User</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Action</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Entity</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr><td colSpan={5} className="text-center py-8 text-gray-500">Loading...</td></tr>
            ) : logs.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-8 text-gray-500">No audit logs found</td></tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {new Date(log.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    {log.first_name} {log.last_name}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`${getActionBadge(log.action)} text-xs`}>{log.action}</span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {log.entity}
                    {log.entity_id && <span className="text-gray-400 ml-1">({log.entity_id.slice(0, 8)}...)</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">{log.ip_address || '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          {Array.from({ length: pagination.totalPages }, (_, i) => i + 1).map((page) => (
            <button
              key={page}
              onClick={() => fetchLogs(page)}
              className={`px-3 py-1 rounded-lg text-sm ${
                page === pagination.page ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {page}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
