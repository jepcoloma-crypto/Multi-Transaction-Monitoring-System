import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { Smartphone, Plus, Search, Package, X, Edit2, Trash2 } from 'lucide-react';
import Pagination from '../components/Pagination';

interface LoadingTx {
  id: string; transaction_number: number; customer_number: string; quantity: number;
  unit_cost: number; unit_price: number; total_cost: number; total_revenue: number;
  profit: number; product_name: string; account_name: string; payment_method: string;
  status: string; created_at: string; created_by_email: string;
}

interface Product { id: string; name: string; provider_name: string; provider_id: string; cost_price: number; selling_price: number; denomination: number | null; provider_convenience_fee: number; company_additional_charge: number; is_active: boolean; notes: string | null; }
interface Provider { id: string; name: string; code: string; }
interface Account { id: string; name: string; masked_account_number: string; current_balance: number; provider_name: string; status: string; }
interface LoadingSummary { totalSales: number; totalRevenue: number; totalCost: number; totalProfit: number; totalConvenienceFees: number; totalCompanyCharges: number; }

export default function Loading() {
  const [txns, setTxns] = useState<LoadingTx[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [summary, setSummary] = useState<LoadingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'sales' | 'products'>('sales');
  const [showModal, setShowModal] = useState(false);
  const [showProductModal, setShowProductModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [search, setSearch] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [form, setForm] = useState({ accountId: '', productId: '', customerNumber: '', quantity: '1', paymentMethod: 'cash', referenceNumber: '', notes: '' });
  const [productForm, setProductForm] = useState({ name: '', providerId: '', costPrice: '', sellingPrice: '', denomination: '', providerConvenienceFee: '', companyAdditionalCharge: '', notes: '' });
  const [submitting, setSubmitting] = useState(false);

  const loadData = async (page = 1) => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      const [t, p, pv, a, s] = await Promise.all([
        api.get<{ data: LoadingTx[]; pagination: any }>(`/loading?${params}`),
        api.get<Product[]>('/loading/products'),
        api.get<Provider[]>('/providers'),
        api.get<{ data: Account[] }>('/accounts?limit=100'),
        api.get<{ summary: LoadingSummary }>('/loading/summary'),
      ]);
      setTxns(t.data);
      setPagination(t.pagination);
      setProducts(p);
      setProviders(pv);
      setAccounts(a.data);
      setSummary(s.summary);
    } catch (err: any) { console.error('Loading page error:', err); } finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, []);

  const filteredTxns = txns.filter(t =>
    !search || t.customer_number.toLowerCase().includes(search.toLowerCase()) ||
    t.product_name.toLowerCase().includes(search.toLowerCase())
  );

  const filteredProducts = products.filter(p =>
    !productSearch || p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
    p.provider_name.toLowerCase().includes(productSearch.toLowerCase())
  );

  const selectedProduct = products.find(p => p.id === form.productId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post('/loading', { ...form, quantity: parseInt(form.quantity || '1') });
      setShowModal(false);
      setForm({ accountId: '', productId: '', customerNumber: '', quantity: '1', paymentMethod: 'cash', referenceNumber: '', notes: '' });
      loadData(1);
    } catch (err: any) { alert(err.response?.data?.message || 'Failed'); } finally { setSubmitting(false); }
  };

  const openCreateProduct = () => {
    setEditingProduct(null);
    setProductForm({ name: '', providerId: '', costPrice: '', sellingPrice: '', denomination: '', providerConvenienceFee: '', companyAdditionalCharge: '', notes: '' });
    setShowProductModal(true);
  };

  const openEditProduct = (p: Product) => {
    setEditingProduct(p);
    setProductForm({
      name: p.name, providerId: p.provider_id,
      costPrice: String(p.cost_price), sellingPrice: String(p.selling_price),
      denomination: p.denomination ? String(p.denomination) : '', providerConvenienceFee: String(p.provider_convenience_fee || 0),
      companyAdditionalCharge: String(p.company_additional_charge || 0),
      notes: p.notes || '',
    });
    setShowProductModal(true);
  };

  const handleProductSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const body = { ...productForm, costPrice: parseFloat(productForm.costPrice), sellingPrice: parseFloat(productForm.sellingPrice), denomination: productForm.denomination ? parseFloat(productForm.denomination) : undefined, providerConvenienceFee: parseFloat(productForm.providerConvenienceFee || '0'), companyAdditionalCharge: parseFloat(productForm.companyAdditionalCharge || '0') };
      if (editingProduct) {
        await api.put(`/loading/products/${editingProduct.id}`, body);
      } else {
        await api.post('/loading/products', body);
      }
      setShowProductModal(false);
      setEditingProduct(null);
      setProductForm({ name: '', providerId: '', costPrice: '', sellingPrice: '', denomination: '', providerConvenienceFee: '', companyAdditionalCharge: '', notes: '' });
      loadData();
    } catch (err: any) { alert(err.message || 'Failed'); }
  };

  const handleToggleProduct = async (p: Product) => {
    try {
      await api.put(`/loading/products/${p.id}`, { isActive: !p.is_active });
      loadData();
    } catch (err: any) { alert(err.message); }
  };

  const handleDeleteTx = async (id: string) => {
    if (!confirm('Delete this loading transaction?')) return;
    try {
      await api.delete(`/loading/${id}`);
      loadData(pagination.page);
    } catch (err: any) { alert(err.message); }
  };

  const handleDeleteProduct = async (id: string) => {
    if (!confirm('Delete this product? Products with sales history cannot be deleted.')) return;
    try {
      await api.delete(`/loading/products/${id}`);
      loadData(pagination.page);
    } catch (err: any) { alert(err.message); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Loading Operations</h2>
          <p className="text-sm text-gray-600">Manage loading sales and inventory</p>
        </div>
        <div className="flex gap-2">
          {activeTab === 'products' && (
            <button onClick={openCreateProduct} className="btn-secondary flex items-center gap-2"><Plus className="w-4 h-4" /> Add Product</button>
          )}
          {activeTab === 'sales' && (
            <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2"><Plus className="w-4 h-4" /> New Sale</button>
          )}
        </div>
      </div>

      <div className="flex gap-1 border-b">
        <button onClick={() => setActiveTab('sales')} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'sales' ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
          Sales Transactions
        </button>
        <button onClick={() => setActiveTab('products')} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'products' ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
          Products ({products.length})
        </button>
      </div>

      {activeTab === 'sales' && (
        <>
          {summary && (
            <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
              <div className="card"><p className="text-sm text-gray-600">Total Sales</p><p className="text-xl font-bold mt-1">{summary.totalSales}</p></div>
              <div className="card"><p className="text-sm text-gray-600">Total Revenue</p><p className="text-xl font-bold text-finance-green mt-1">{formatCurrency(summary.totalRevenue)}</p></div>
              <div className="card"><p className="text-sm text-gray-600">Total Cost</p><p className="text-xl font-bold text-finance-red mt-1">{formatCurrency(summary.totalCost)}</p></div>
              <div className="card"><p className="text-sm text-gray-600">Total Profit</p><p className="text-xl font-bold text-finance-blue mt-1">{formatCurrency(summary.totalProfit)}</p></div>
              <div className="card"><p className="text-sm text-gray-600">Conv. Fees</p><p className="text-xl font-bold text-orange-600 mt-1">{formatCurrency(summary.totalConvenienceFees)}</p></div>
              <div className="card"><p className="text-sm text-gray-600">Company Charges</p><p className="text-xl font-bold text-blue-600 mt-1">{formatCurrency(summary.totalCompanyCharges)}</p></div>
            </div>
          )}

          <div className="flex gap-4 items-center">
            <div className="relative flex-1 max-w-sm">
              <Search className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
              <input type="text" placeholder="Search by customer or product..." value={search} onChange={e => setSearch(e.target.value)} className="input-field pl-9" />
            </div>
          </div>

          {loading ? (
            <div className="card"><div className="text-center py-12 text-gray-500">Loading...</div></div>
          ) : filteredTxns.length === 0 ? (
            <div className="card"><div className="text-center py-12 text-gray-500">
              <Smartphone className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="font-medium">No loading transactions</p>
            </div></div>
          ) : (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[800px]">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase w-12">#</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Customer</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Product</th>
                      <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase w-12">Qty</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Revenue</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Cost</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Profit</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Account</th>
                      <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Created By</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {filteredTxns.map(t => (
                      <tr key={t.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-mono text-sm">{t.transaction_number}</td>
                        <td className="px-4 py-3 text-sm">{t.customer_number}</td>
                        <td className="px-4 py-3 text-sm">{t.product_name}</td>
                        <td className="px-4 py-3 text-sm text-center">{t.quantity}</td>
                        <td className="px-4 py-3 text-sm text-right text-finance-green font-medium">{formatCurrency(t.total_revenue)}</td>
                        <td className="px-4 py-3 text-sm text-right text-finance-red">{formatCurrency(t.total_cost)}</td>
                        <td className="px-4 py-3 text-sm text-right font-medium">{formatCurrency(t.profit)}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{t.account_name}</td>
                        <td className="px-4 py-3 text-center"><span className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${t.status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'}`}>{t.status}</span></td>
                        <td className="px-4 py-3 text-sm text-gray-600">{t.created_by_email || '-'}</td>
                        <td className="px-4 py-3 text-right">
                          <button onClick={() => handleDeleteTx(t.id)} className="p-1 text-gray-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
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
        </>
      )}

      {activeTab === 'products' && (
        <>
          <div className="flex gap-4 items-center">
            <div className="relative flex-1 max-w-sm">
              <Search className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
              <input type="text" placeholder="Search products..." value={productSearch} onChange={e => setProductSearch(e.target.value)} className="input-field pl-9" />
            </div>
          </div>

          {loading ? (
            <div className="card"><div className="text-center py-12 text-gray-500">Loading...</div></div>
          ) : filteredProducts.length === 0 ? (
            <div className="card"><div className="text-center py-12 text-gray-500">
              <Package className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="font-medium">No products found</p>
              <p className="text-sm mt-1">Create a product to start selling loading credits</p>
            </div></div>
          ) : (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[850px]">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Product Name</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Provider</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Cost</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Selling</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Margin</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Conv. Fee</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Co. Charge</th>
                      <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {filteredProducts.map(p => {
                      const margin = p.selling_price - p.cost_price;
                      const marginPct = p.cost_price > 0 ? ((margin / p.cost_price) * 100).toFixed(1) : '0';
                      return (
                        <tr key={p.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">{p.name}</td>
                          <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{p.provider_name}</td>
                          <td className="px-4 py-3 text-sm text-right whitespace-nowrap">{formatCurrency(p.cost_price)}</td>
                          <td className="px-4 py-3 text-sm text-right font-medium text-finance-green whitespace-nowrap">{formatCurrency(p.selling_price)}</td>
                          <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                            <span className={`font-medium ${margin >= 0 ? 'text-finance-green' : 'text-finance-red'}`}>
                              {formatCurrency(margin)} ({marginPct}%)
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-right text-orange-600 whitespace-nowrap">{formatCurrency(p.provider_convenience_fee)}</td>
                          <td className="px-4 py-3 text-sm text-right text-blue-600 whitespace-nowrap">{formatCurrency(p.company_additional_charge)}</td>
                          <td className="px-4 py-3 text-center">
                            <button onClick={() => handleToggleProduct(p)} className={`inline-flex px-2 py-1 rounded-full text-xs font-medium cursor-pointer ${p.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                              {p.is_active ? 'Active' : 'Inactive'}
                            </button>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button onClick={() => openEditProduct(p)} className="p-1 text-gray-400 hover:text-primary-600"><Edit2 className="w-4 h-4" /></button>
                            <button onClick={() => handleDeleteProduct(p.id)} className="p-1 text-gray-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">New Loading Sale</h3>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="form-label">Account *</label>
                <select required value={form.accountId} onChange={e => setForm({ ...form, accountId: e.target.value })} className="input-field">
                  <option value="">Select account</option>
                  {accounts.filter(a => a.status === 'active').map(a => <option key={a.id} value={a.id}>{a.name} ({a.provider_name}{a.masked_account_number ? ` · ${a.masked_account_number}` : ''}) - {formatCurrency(a.current_balance)}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label">Product *</label>
                <select required value={form.productId} onChange={e => setForm({ ...form, productId: e.target.value })} className="input-field">
                  <option value="">Select product</option>
                  {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.provider_name}) - {formatCurrency(p.selling_price)}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label">Customer Number *</label>
                <input type="text" required value={form.customerNumber} onChange={e => setForm({ ...form, customerNumber: e.target.value })} className="input-field" placeholder="e.g., 09171234567" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Quantity</label>
                  <input type="number" min="1" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="form-label">Payment Method</label>
                  <select value={form.paymentMethod} onChange={e => setForm({ ...form, paymentMethod: e.target.value })} className="input-field">
                    <option value="cash">Cash</option>
                    <option value="gcash">GCash</option>
                    <option value="maya">Maya</option>
                    <option value="bank">Bank</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="form-label">Reference Number</label>
                <input type="text" value={form.referenceNumber} onChange={e => setForm({ ...form, referenceNumber: e.target.value })} className="input-field" placeholder="Optional" />
              </div>
              {selectedProduct && (
                <div className="p-3 bg-gray-50 rounded-lg text-sm space-y-1">
                  <p>Unit Cost: <span className="font-medium">{formatCurrency(selectedProduct.cost_price)}</span></p>
                  <p>Unit Price: <span className="font-medium">{formatCurrency(selectedProduct.selling_price)}</span></p>
                  {(() => {
                    const convFee = Number(selectedProduct.provider_convenience_fee) || 0;
                    const companyCharge = Number(selectedProduct.company_additional_charge) || 0;
                    const qty = parseInt(form.quantity || '1');
                    const totalConvFee = convFee * qty;
                    const totalCompanyCharge = companyCharge;
                    const totalCustomerCharge = (selectedProduct.selling_price * qty) + totalConvFee + totalCompanyCharge;
                    const totalBalanceDeduction = (selectedProduct.cost_price * qty) + totalConvFee;
                    return (
                      <>
                        {convFee > 0 && <p>Provider Conv. Fee: <span className="font-medium text-orange-600">{formatCurrency(convFee)} × {qty} = {formatCurrency(totalConvFee)}</span></p>}
                        {companyCharge > 0 && <p>Company Charge: <span className="font-medium text-blue-600">{formatCurrency(companyCharge)}</span></p>}
                        <p>Expected Profit: <span className="font-medium text-finance-green">{formatCurrency((selectedProduct.selling_price - selectedProduct.cost_price) * qty)}</span></p>
                        <p className="border-t pt-1">Balance Deduction: <span className="font-bold">{formatCurrency(totalBalanceDeduction)}</span></p>
                        <p>Customer Pays: <span className="font-bold text-primary-600">{formatCurrency(totalCustomerCharge)}</span></p>
                        <p className="text-xs text-gray-500">(Selling Price + Conv. Fee + Company Charge)</p>
                      </>
                    );
                  })()}
                </div>
              )}
              <div className="flex gap-3 justify-end">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary">Cancel</button>
                <button type="submit" disabled={submitting} className="btn-primary">{submitting ? 'Processing...' : 'Complete Sale'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showProductModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">{editingProduct ? 'Edit Product' : 'Add Loading Product'}</h3>
              <button onClick={() => { setShowProductModal(false); setEditingProduct(null); }} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleProductSubmit} className="space-y-4">
              <div>
                <label className="form-label">Product Name *</label>
                <input type="text" required value={productForm.name} onChange={e => setProductForm({ ...productForm, name: e.target.value })} className="input-field" placeholder="e.g., Smart Load 50" />
              </div>
              <div>
                <label className="form-label">Provider *</label>
                <select required value={productForm.providerId} onChange={e => setProductForm({ ...productForm, providerId: e.target.value })} className="input-field" disabled={!!editingProduct}>
                  <option value="">Select provider</option>
                  {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Cost Price *</label>
                  <input type="number" step="0.01" min="0" required value={productForm.costPrice} onChange={e => setProductForm({ ...productForm, costPrice: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="form-label">Selling Price *</label>
                  <input type="number" step="0.01" min="0" required value={productForm.sellingPrice} onChange={e => setProductForm({ ...productForm, sellingPrice: e.target.value })} className="input-field" />
                </div>
              </div>
              <div>
                <label className="form-label">Denomination</label>
                <input type="number" step="0.01" min="0" value={productForm.denomination} onChange={e => setProductForm({ ...productForm, denomination: e.target.value })} className="input-field" placeholder="Optional" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Provider Conv. Fee (per unit)</label>
                  <input type="number" step="0.01" min="0" value={productForm.providerConvenienceFee} onChange={e => setProductForm({ ...productForm, providerConvenienceFee: e.target.value })} className="input-field" placeholder="0.00" />
                  <p className="text-xs text-gray-500 mt-1">Fee charged by provider to us</p>
                </div>
                <div>
                  <label className="form-label">Company Additional Charge</label>
                  <input type="number" step="0.01" min="0" value={productForm.companyAdditionalCharge} onChange={e => setProductForm({ ...productForm, companyAdditionalCharge: e.target.value })} className="input-field" placeholder="0.00" />
                  <p className="text-xs text-gray-500 mt-1">Charge to customer (revenue)</p>
                </div>
              </div>
              <div>
                <label className="form-label">Notes</label>
                <input type="text" value={productForm.notes} onChange={e => setProductForm({ ...productForm, notes: e.target.value })} className="input-field" placeholder="Optional" />
              </div>
              <div className="flex gap-3 justify-end">
                <button type="button" onClick={() => { setShowProductModal(false); setEditingProduct(null); }} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">{editingProduct ? 'Update Product' : 'Create Product'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
