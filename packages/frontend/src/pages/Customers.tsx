import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { Plus, Search, Edit2, Trash2, X, Phone, Mail, MapPin, ArrowUpRight, ArrowDownLeft } from 'lucide-react';

interface Customer {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  id_type: string | null;
  id_number: string | null;
  notes: string | null;
  status: string;
  created_by_email: string | null;
  created_at: string;
  linkedTransactions?: any[];
  nameMatchedTransactions?: any[];
  totalTransactions?: number;
}

export default function Customers() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [detail, setDetail] = useState<Customer | null>(null);
  const [formData, setFormData] = useState({
    firstName: '', lastName: '', email: '', phone: '', address: '', idType: '', idNumber: '', notes: '',
  });

  const fetchCustomers = async (page = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (search) params.set('search', search);
      const result = await api.get<{ data: Customer[]; pagination: any }>(`/customers?${params}`);
      setCustomers(result.data);
      setPagination(result.pagination);
    } catch (err) { console.error('Customers load error:', err); } finally { setLoading(false); }
  };

  useEffect(() => { fetchCustomers(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editing) {
        await api.put(`/customers/${editing.id}`, formData);
      } else {
        await api.post('/customers', formData);
      }
      setShowModal(false);
      setEditing(null);
      setFormData({ firstName: '', lastName: '', email: '', phone: '', address: '', idType: '', idNumber: '', notes: '' });
      fetchCustomers(pagination.page);
    } catch (err: any) { alert(err.message); }
  };

  const handleEdit = (c: Customer) => {
    setEditing(c);
    setFormData({
      firstName: c.first_name, lastName: c.last_name, email: c.email || '',
      phone: c.phone || '', address: c.address || '', idType: c.id_type || '',
      idNumber: c.id_number || '', notes: c.notes || '',
    });
    setShowModal(true);
  };

  const handleDeactivate = async (id: string) => {
    if (!confirm('Deactivate this customer?')) return;
    try {
      await api.delete(`/customers/${id}`);
      fetchCustomers(pagination.page);
    } catch (err: any) { alert(err.message); }
  };

  const handleViewDetail = async (c: Customer) => {
    try {
      const result = await api.get<any>(`/customers/${c.id}`);
      setDetail(result);
    } catch (err: any) { alert(err.message); }
  };

  const openCreate = () => {
    setEditing(null);
    setFormData({ firstName: '', lastName: '', email: '', phone: '', address: '', idType: '', idNumber: '', notes: '' });
    setShowModal(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Customers</h2>
        <button onClick={openCreate} className="btn-primary flex items-center gap-2"><Plus className="w-4 h-4" /> Add Customer</button>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input type="text" placeholder="Search customers..." value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchCustomers(1)}
            className="input pl-10" />
        </div>
        <button onClick={() => fetchCustomers(1)} className="btn-secondary">Search</button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[800px]">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Contact</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">ID</th>
              <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr><td colSpan={5} className="text-center py-8 text-gray-500">Loading...</td></tr>
            ) : customers.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-8 text-gray-500">No customers found</td></tr>
            ) : (
              customers.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <button onClick={() => handleViewDetail(c)} className="text-left hover:text-primary-600">
                      <p className="text-sm font-medium text-gray-900">{c.last_name}, {c.first_name}</p>
                      {c.notes && <p className="text-xs text-gray-400 truncate max-w-[200px]">{c.notes}</p>}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {c.phone && <p className="flex items-center gap-1"><Phone className="w-3 h-3" /> {c.phone}</p>}
                    {c.email && <p className="flex items-center gap-1"><Mail className="w-3 h-3" /> {c.email}</p>}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {c.id_type && <p>{c.id_type}: {c.id_number}</p>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${c.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => handleEdit(c)} className="text-gray-400 hover:text-primary-600"><Edit2 className="w-4 h-4" /></button>
                      {c.status === 'active' && (
                        <button onClick={() => handleDeactivate(c.id)} className="text-gray-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-gray-500">Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)</p>
            <div className="flex gap-2">
              <button onClick={() => fetchCustomers(pagination.page - 1)} disabled={pagination.page <= 1} className="btn-secondary text-sm disabled:opacity-50">Prev</button>
              <button onClick={() => fetchCustomers(pagination.page + 1)} disabled={pagination.page >= pagination.totalPages} className="btn-secondary text-sm disabled:opacity-50">Next</button>
            </div>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      {detail && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold">{detail.last_name}, {detail.first_name}</h3>
              <button onClick={() => setDetail(null)}><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  {detail.phone && <p className="text-sm flex items-center gap-2"><Phone className="w-4 h-4 text-gray-400" /> {detail.phone}</p>}
                  {detail.email && <p className="text-sm flex items-center gap-2"><Mail className="w-4 h-4 text-gray-400" /> {detail.email}</p>}
                  {detail.address && <p className="text-sm flex items-center gap-2"><MapPin className="w-4 h-4 text-gray-400" /> {detail.address}</p>}
                </div>
                <div className="space-y-2">
                  {detail.id_type && <p className="text-sm"><span className="text-gray-500">ID:</span> {detail.id_type} - {detail.id_number}</p>}
                  {detail.notes && <p className="text-sm bg-yellow-50 border border-yellow-200 rounded p-2">{detail.notes}</p>}
                  <p className="text-xs text-gray-400">Created by: {detail.created_by_email}</p>
                </div>
              </div>

              {/* Transaction History */}
              <div className="border-t pt-4">
                <h4 className="text-sm font-semibold text-gray-900 mb-2">Transaction History ({detail.totalTransactions || 0})</h4>
                {(!detail.linkedTransactions?.length && !detail.nameMatchedTransactions?.length) ? (
                  <p className="text-sm text-gray-500">No transactions found</p>
                ) : (
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {detail.linkedTransactions?.map((tx: any) => (
                      <div key={tx.id} className="p-2 bg-gray-50 rounded">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {tx.direction === 'in' ? <ArrowDownLeft className="w-4 h-4 text-green-500" /> : <ArrowUpRight className="w-4 h-4 text-red-500" />}
                            <div>
                              <p className="text-xs font-medium">#{tx.transaction_number} - {tx.type_name}</p>
                              <p className="text-xs text-gray-500">{tx.account_name} | {new Date(tx.transaction_date).toLocaleDateString()}</p>
                            </div>
                          </div>
                          <span className={`text-sm font-medium ${tx.direction === 'in' ? 'text-green-600' : 'text-red-600'}`}>
                            {tx.direction === 'in' ? '+' : '-'}{formatCurrency(tx.amount)}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-[11px] text-gray-500">
                          {tx.fee > 0 && <span>Fee: {formatCurrency(tx.fee)}</span>}
                          {tx.additional_charges?.length > 0 && <span>Charges: {formatCurrency(tx.additional_charges.reduce((sum: number, c: any) => sum + c.amount, 0))}</span>}
                          {tx.reference_number && <span>Ref: {tx.reference_number}</span>}
                          <span className={`px-1.5 py-0.5 rounded ${tx.status === 'completed' ? 'bg-green-100 text-green-700' : tx.status === 'reversed' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>{tx.status}</span>
                        </div>
                        {tx.description && <p className="text-[11px] text-gray-400 mt-0.5">{tx.description}</p>}
                      </div>
                    ))}
                    {detail.nameMatchedTransactions?.map((tx: any) => (
                      <div key={tx.id} className="p-2 bg-yellow-50 rounded border border-yellow-200">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {tx.direction === 'in' ? <ArrowDownLeft className="w-4 h-4 text-green-500" /> : <ArrowUpRight className="w-4 h-4 text-red-500" />}
                            <div>
                              <p className="text-xs font-medium">#{tx.transaction_number} - {tx.type_name} <span className="text-yellow-600">(name match)</span></p>
                              <p className="text-xs text-gray-500">{tx.account_name} | {new Date(tx.transaction_date).toLocaleDateString()}</p>
                            </div>
                          </div>
                          <span className={`text-sm font-medium ${tx.direction === 'in' ? 'text-green-600' : 'text-red-600'}`}>
                            {tx.direction === 'in' ? '+' : '-'}{formatCurrency(tx.amount)}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-[11px] text-gray-500">
                          {tx.fee > 0 && <span>Fee: {formatCurrency(tx.fee)}</span>}
                          {tx.additional_charges?.length > 0 && <span>Charges: {formatCurrency(tx.additional_charges.reduce((sum: number, c: any) => sum + c.amount, 0))}</span>}
                          {tx.reference_number && <span>Ref: {tx.reference_number}</span>}
                          <span className={`px-1.5 py-0.5 rounded ${tx.status === 'completed' ? 'bg-green-100 text-green-700' : tx.status === 'reversed' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>{tx.status}</span>
                        </div>
                        {tx.description && <p className="text-[11px] text-gray-400 mt-0.5">{tx.description}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t">
              <button onClick={() => { setDetail(null); handleEdit(detail); }} className="btn-secondary text-sm">Edit</button>
              <button onClick={() => setDetail(null)} className="btn-secondary text-sm">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-lg font-semibold">{editing ? 'Edit Customer' : 'New Customer'}</h3>
              <button onClick={() => { setShowModal(false); setEditing(null); }}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">First Name *</label>
                  <input type="text" required value={formData.firstName} onChange={(e) => setFormData({ ...formData, firstName: e.target.value })} className="input" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Last Name *</label>
                  <input type="text" required value={formData.lastName} onChange={(e) => setFormData({ ...formData, lastName: e.target.value })} className="input" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                  <input type="text" value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })} className="input" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input type="email" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} className="input" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                <textarea value={formData.address} onChange={(e) => setFormData({ ...formData, address: e.target.value })} className="input" rows={2} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">ID Type</label>
                  <select value={formData.idType} onChange={(e) => setFormData({ ...formData, idType: e.target.value })} className="input">
                    <option value="">Select</option>
                    <option value="National ID">National ID</option>
                    <option value="Passport">Passport</option>
                    <option value="Driver's License">Driver's License</option>
                    <option value="SSS">SSS</option>
                    <option value="PhilHealth">PhilHealth</option>
                    <option value="TIN">TIN</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">ID Number</label>
                  <input type="text" value={formData.idNumber} onChange={(e) => setFormData({ ...formData, idNumber: e.target.value })} className="input" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} className="input" rows={2} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => { setShowModal(false); setEditing(null); }} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">{editing ? 'Update' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
