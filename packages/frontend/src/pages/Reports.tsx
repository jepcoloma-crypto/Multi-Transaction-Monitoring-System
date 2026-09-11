import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { BarChart3, FileText, ArrowLeftRight, Smartphone, Download } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

type ReportType = 'account-statement' | 'transaction-report' | 'transfer-report' | 'loading-report' | 'consolidated';

interface Account { id: string; name: string; masked_account_number: string; }

export default function Reports() {
  const [activeReport, setActiveReport] = useState<ReportType>('consolidated');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [reportData, setReportData] = useState<any>(null);
  const [filters, setFilters] = useState({ startDate: '', endDate: '', accountId: '', typeId: '', status: '', providerId: '' });

  useEffect(() => {
    api.get<{ data: Account[] }>('/accounts').then(res => setAccounts(res.data)).catch(() => {});
  }, []);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
      if (filters.accountId) params.append('accountId', filters.accountId);
      if (filters.typeId) params.append('typeId', filters.typeId);
      if (filters.status) params.append('status', filters.status);
      if (filters.providerId) params.append('providerId', filters.providerId);
      const qs = params.toString();
      const url = `/reports/${activeReport}${qs ? `?${qs}` : ''}`;
      const data = await api.get(url);
      setReportData(data);
    } catch (err) { console.error('Reports load error:', err); } finally { setLoading(false); }
  }, [activeReport, filters]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const exportCSV = async (type: string) => {
    try {
      const params = new URLSearchParams();
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
      params.append('format', 'csv');
      const qs = params.toString();
      const res = await fetch(`${API_BASE}/reports/export/${type}?${qs}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${type}_export.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { console.error('Report export error:', err); }
  };

  const reports = [
    { id: 'consolidated' as ReportType, name: 'Consolidated Overview', icon: BarChart3, desc: 'All accounts, transactions, transfers, and loading summary' },
    { id: 'account-statement' as ReportType, name: 'Account Statement', icon: FileText, desc: 'Detailed ledger entries for a specific account' },
    { id: 'transaction-report' as ReportType, name: 'Transaction Report', icon: FileText, desc: 'Transaction history with filters' },
    { id: 'transfer-report' as ReportType, name: 'Transfer Report', icon: ArrowLeftRight, desc: 'Fund transfer history' },
    { id: 'loading-report' as ReportType, name: 'Loading Report', icon: Smartphone, desc: 'Loading sales and profit analysis' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Reports & Analytics</h2>
        <p className="text-sm text-gray-600">Financial reports and data export</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-1 space-y-2">
          {reports.map(r => (
            <button key={r.id} onClick={() => { setActiveReport(r.id); setReportData(null); }}
              className={`w-full text-left p-3 rounded-lg transition-colors ${activeReport === r.id ? 'bg-primary-100 text-primary-700 border border-primary-200' : 'text-gray-700 hover:bg-gray-100'}`}>
              <div className="flex items-center gap-3">
                <r.icon className="w-5 h-5" />
                <div>
                  <p className="text-sm font-medium">{r.name}</p>
                  <p className="text-xs text-gray-500">{r.desc}</p>
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="lg:col-span-3 space-y-4">
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">{reports.find(r => r.id === activeReport)?.name}</h3>
              <button onClick={() => exportCSV(activeReport === 'account-statement' ? 'ledger' : activeReport.replace('-report', '').replace('account-', ''))}
                className="btn-secondary flex items-center gap-2 text-sm">
                <Download className="w-4 h-4" /> Export CSV
              </button>
            </div>

            <div className="flex flex-wrap gap-3 mb-4">
              <div>
                <label className="text-xs text-gray-500">From</label>
                <input type="date" value={filters.startDate} onChange={e => setFilters({ ...filters, startDate: e.target.value })} className="input-field text-sm" />
              </div>
              <div>
                <label className="text-xs text-gray-500">To</label>
                <input type="date" value={filters.endDate} onChange={e => setFilters({ ...filters, endDate: e.target.value })} className="input-field text-sm" />
              </div>
              {(activeReport === 'account-statement' || activeReport === 'transaction-report') && (
                <div>
                  <label className="text-xs text-gray-500">Account</label>
                  <select value={filters.accountId} onChange={e => setFilters({ ...filters, accountId: e.target.value })} className="input-field text-sm">
                    <option value="">All Accounts</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              )}
              {activeReport === 'transfer-report' && (
                <div>
                  <label className="text-xs text-gray-500">Status</label>
                  <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })} className="input-field text-sm">
                    <option value="">All</option>
                    <option value="completed">Completed</option>
                    <option value="pending">Pending</option>
                    <option value="failed">Failed</option>
                  </select>
                </div>
              )}
            </div>
          </div>

          {loading ? (
            <div className="card"><div className="text-center py-12 text-gray-500">Loading report...</div></div>
          ) : !reportData ? (
            <div className="card"><div className="text-center py-12 text-gray-500"><BarChart3 className="w-12 h-12 mx-auto mb-3 opacity-50" /><p>Select filters and report type</p></div></div>
          ) : activeReport === 'consolidated' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="card">
                  <p className="text-sm text-gray-600">Total Accounts</p>
                  <p className="text-2xl font-bold mt-1">{reportData.accounts?.count || 0}</p>
                  <p className="text-sm text-gray-500">Balance: {formatCurrency(reportData.accounts?.totalBalance || 0)}</p>
                </div>
                <div className="card">
                  <p className="text-sm text-gray-600">Transactions</p>
                  <p className="text-2xl font-bold mt-1">{reportData.transactions?.count || 0}</p>
                  <p className="text-sm text-finance-green">In: {formatCurrency(reportData.transactions?.totalIn || 0)}</p>
                  <p className="text-sm text-finance-red">Out: {formatCurrency(reportData.transactions?.totalOut || 0)}</p>
                </div>
                <div className="card">
                  <p className="text-sm text-gray-600">Fund Transfers</p>
                  <p className="text-2xl font-bold mt-1">{reportData.transfers?.count || 0}</p>
                  <p className="text-sm text-gray-500">Amount: {formatCurrency(reportData.transfers?.totalAmount || 0)}</p>
                  <p className="text-sm text-gray-500">Fees: {formatCurrency(reportData.transfers?.totalFees || 0)}</p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="card">
                  <p className="text-sm text-gray-600">Loading Operations</p>
                  <p className="text-2xl font-bold text-finance-green mt-1">{formatCurrency(reportData.loading?.totalProfit || 0)} profit</p>
                  <p className="text-sm text-gray-500">{reportData.loading?.count || 0} sales | Revenue: {formatCurrency(reportData.loading?.totalRevenue || 0)}</p>
                </div>
                <div className="card">
                  <p className="text-sm text-gray-600">Reconciliation</p>
                  <p className="text-2xl font-bold mt-1">{reportData.reconciliation?.reconciled || 0} / {reportData.reconciliation?.total || 0}</p>
                  <p className="text-sm text-gray-500">Reconciled accounts</p>
                </div>
              </div>
            </div>
          ) : activeReport === 'account-statement' && reportData.entries ? (
            <div className="space-y-4">
              <div className="card">
                <h4 className="font-medium mb-2">{reportData.account?.name} - Ledger Entries</h4>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div><p className="text-gray-500">Total In</p><p className="font-bold text-finance-green">{formatCurrency(reportData.summary?.totalIn || 0)}</p></div>
                  <div><p className="text-gray-500">Total Out</p><p className="font-bold text-finance-red">{formatCurrency(reportData.summary?.totalOut || 0)}</p></div>
                  <div><p className="text-gray-500">Net</p><p className="font-bold">{formatCurrency(reportData.summary?.netMovement || 0)}</p></div>
                </div>
              </div>
              <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[700px]">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Date</th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Type</th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Description</th>
                        <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Amount</th>
                        <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {reportData.entries.map((e: any) => (
                        <tr key={e.id} className="hover:bg-gray-50">
                          <td className="px-6 py-3.5 text-sm whitespace-nowrap">{new Date(e.entry_date).toLocaleDateString()}</td>
                          <td className="px-6 py-3.5 whitespace-nowrap"><span className={`text-xs font-medium ${e.entry_type === 'credit' ? 'text-green-600' : 'text-red-600'}`}>{e.entry_type}</span></td>
                          <td className="px-6 py-3.5 text-sm">{e.description || e.type_name || '-'}</td>
                          <td className={`px-6 py-3.5 text-sm font-medium text-right whitespace-nowrap ${e.entry_type === 'credit' ? 'text-green-600' : 'text-red-600'}`}>{e.entry_type === 'credit' ? '+' : '-'}{formatCurrency(e.amount)}</td>
                          <td className="px-6 py-3.5 text-sm font-medium text-right whitespace-nowrap">{formatCurrency(e.balance_after)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : activeReport === 'transaction-report' && reportData.transactions ? (
            <div className="space-y-4">
              <div className="card">
                <div className="grid grid-cols-4 gap-4 text-sm">
                  <div><p className="text-gray-500">Count</p><p className="font-bold">{reportData.summary?.count || 0}</p></div>
                  <div><p className="text-gray-500">Money In</p><p className="font-bold text-finance-green">{formatCurrency(reportData.summary?.totalIn || 0)}</p></div>
                  <div><p className="text-gray-500">Money Out</p><p className="font-bold text-finance-red">{formatCurrency(reportData.summary?.totalOut || 0)}</p></div>
                  <div><p className="text-gray-500">Adjustments</p><p className="font-bold">{formatCurrency(reportData.summary?.totalAdjustments || 0)}</p></div>
                </div>
              </div>
              <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[800px]">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">#</th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Type</th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Account</th>
                        <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Amount</th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Date</th>
                        <th className="text-center px-6 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {reportData.transactions.slice(0, 50).map((t: any) => (
                        <tr key={t.id} className="hover:bg-gray-50">
                          <td className="px-6 py-3.5 font-mono text-sm whitespace-nowrap">{t.transaction_number}</td>
                          <td className="px-6 py-3.5 text-sm whitespace-nowrap">{t.type_name}</td>
                          <td className="px-6 py-3.5 text-sm whitespace-nowrap">{t.account_name}</td>
                          <td className={`px-6 py-3.5 text-sm font-medium text-right whitespace-nowrap ${t.direction === 'in' ? 'text-green-600' : 'text-red-600'}`}>{t.direction === 'in' ? '+' : '-'}{formatCurrency(t.amount)}</td>
                          <td className="px-6 py-3.5 text-sm text-gray-600 whitespace-nowrap">{t.category_name || '-'}</td>
                          <td className="px-6 py-3.5 text-sm whitespace-nowrap">{new Date(t.transaction_date).toLocaleDateString()}</td>
                          <td className="px-6 py-3.5 text-center"><span className={`text-xs font-medium ${t.status === 'completed' ? 'text-green-600' : 'text-yellow-600'}`}>{t.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : activeReport === 'transfer-report' && reportData.transfers ? (
            <div className="space-y-4">
              <div className="card">
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div><p className="text-gray-500">Count</p><p className="font-bold">{reportData.summary?.count || 0}</p></div>
                  <div><p className="text-gray-500">Total Amount</p><p className="font-bold">{formatCurrency(reportData.summary?.totalAmount || 0)}</p></div>
                  <div><p className="text-gray-500">Total Fees</p><p className="font-bold">{formatCurrency(reportData.summary?.totalFees || 0)}</p></div>
                </div>
              </div>
              <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[800px]">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">#</th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">From</th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">To</th>
                        <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Amount</th>
                        <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Fee</th>
                        <th className="text-center px-6 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {reportData.transfers.map((t: any) => (
                        <tr key={t.id} className="hover:bg-gray-50">
                          <td className="px-6 py-3.5 font-mono text-sm whitespace-nowrap">{t.transfer_number}</td>
                          <td className="px-6 py-3.5 text-sm whitespace-nowrap">{t.source_name}</td>
                          <td className="px-6 py-3.5 text-sm whitespace-nowrap">{t.destination_name}</td>
                          <td className="px-6 py-3.5 text-sm font-medium text-right whitespace-nowrap">{formatCurrency(t.transfer_amount)}</td>
                          <td className="px-6 py-3.5 text-sm text-right whitespace-nowrap">{formatCurrency(parseFloat(t.transfer_fee))}</td>
                          <td className="px-6 py-3.5 text-center"><span className={`text-xs font-medium ${t.status === 'completed' ? 'text-green-600' : 'text-yellow-600'}`}>{t.status}</span></td>
                          <td className="px-6 py-3.5 text-sm whitespace-nowrap">{new Date(t.transfer_date).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : activeReport === 'loading-report' && reportData.sales ? (
            <div className="space-y-4">
              <div className="card">
                <div className="grid grid-cols-4 gap-4 text-sm">
                  <div><p className="text-gray-500">Sales</p><p className="font-bold">{reportData.summary?.count || 0}</p></div>
                  <div><p className="text-gray-500">Revenue</p><p className="font-bold text-finance-green">{formatCurrency(reportData.summary?.totalRevenue || 0)}</p></div>
                  <div><p className="text-gray-500">Cost</p><p className="font-bold text-finance-red">{formatCurrency(reportData.summary?.totalCost || 0)}</p></div>
                  <div><p className="text-gray-500">Profit</p><p className="font-bold text-finance-blue">{formatCurrency(reportData.summary?.totalProfit || 0)}</p></div>
                </div>
              </div>
              {reportData.byProvider?.length > 0 && (
                <div className="card">
                  <h4 className="font-medium mb-3">Profit by Provider</h4>
                  {reportData.byProvider.map((p: any) => (
                    <div key={p.provider_name} className="flex justify-between items-center py-2 border-b last:border-0">
                      <span className="text-sm">{p.provider_name}</span>
                      <span className="text-sm font-medium text-finance-green">{p.count} sales | {formatCurrency(p.profit)} profit</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[800px]">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">#</th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Product</th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Customer</th>
                        <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Qty</th>
                        <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Revenue</th>
                        <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Profit</th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {reportData.sales.slice(0, 50).map((s: any) => (
                        <tr key={s.id} className="hover:bg-gray-50">
                          <td className="px-6 py-3.5 font-mono text-sm whitespace-nowrap">{s.transaction_number}</td>
                          <td className="px-6 py-3.5 text-sm whitespace-nowrap">{s.product_name}</td>
                          <td className="px-6 py-3.5 text-sm whitespace-nowrap">{s.customer_number}</td>
                          <td className="px-6 py-3.5 text-sm text-right whitespace-nowrap">{s.quantity}</td>
                          <td className="px-6 py-3.5 text-sm text-finance-green text-right whitespace-nowrap">{formatCurrency(s.total_revenue)}</td>
                          <td className="px-6 py-3.5 text-sm font-medium text-right whitespace-nowrap">{formatCurrency(s.profit)}</td>
                          <td className="px-6 py-3.5 text-sm whitespace-nowrap">{new Date(s.created_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
