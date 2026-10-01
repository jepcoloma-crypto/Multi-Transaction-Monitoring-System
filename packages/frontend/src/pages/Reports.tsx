import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { api } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { BarChart3, FileText, ArrowLeftRight, Smartphone, Download, ShieldCheck, RotateCcw, TrendingUp, ChevronRight } from 'lucide-react';
import { IncomeDetailPanel, type IncomeDetailTab } from '../components/IncomeDetail';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

type ReportType = 'account-statement' | 'transaction-report' | 'transfer-report' | 'loading-report' | 'consolidated' | 'balance-reconciliation' | 'reversal-report' | 'income-report';

interface Account { id: string; name: string; masked_account_number: string; }

// Both sides are read from the ledger rows the reversal wrote rather than
// derived from the transaction's direction: an operator asking whether a figure
// was debited or credited wants what the books actually say, not an inference.
const sideLabel = (side: string | null): string =>
  side === 'credit' ? 'Credit' : side === 'debit' ? 'Debit' : '—';

const sideClass = (side: string | null): string =>
  side === 'credit' ? 'text-finance-green' : side === 'debit' ? 'text-finance-red' : 'text-gray-500';

// A compensating entry is a completed transaction wearing an adjustment type,
// so the stored status undersells it. The badge names the role instead, and the
// statement then reads original/reversal/original/reversal rather than
// original/reversal/completed.
const statusBadgeClass = (status: string | null): string =>
  status === 'reversed' ? 'bg-amber-100 text-amber-700'
    : status === 'reversal' ? 'bg-green-100 text-green-700'
    : status === 'completed' ? 'bg-green-100 text-green-700'
    : status ? 'bg-gray-100 text-gray-600' : 'bg-gray-50 text-gray-400';

const statementStatusLabel = (status: string | null, entrySource: string | null): string =>
  status || (entrySource === 'transaction' ? '—' : 'ledger');

export default function Reports() {
  const [activeReport, setActiveReport] = useState<ReportType>('consolidated');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [reportData, setReportData] = useState<any>(null);
  const [filters, setFilters] = useState({ startDate: '', endDate: '', accountId: '', typeId: '', status: '', providerId: '' });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, any>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});
  const [detailTabs, setDetailTabs] = useState<Record<string, IncomeDetailTab>>({});
  const requestedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    api.get<{ data: Account[] }>('/accounts').then(res => setAccounts(res.data)).catch(() => {});
  }, []);

  // Cached detail rows are only meaningful under the filters they were fetched
  // with, so they are dropped alongside the report they explain rather than
  // surviving a date change and contradicting the new totals.
  const clearDetail = useCallback(() => {
    setExpanded({});
    setDetails({});
    setDetailLoading({});
    setDetailTabs({});
    requestedRef.current.clear();
  }, []);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    clearDetail();
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
  }, [activeReport, clearDetail, filters]);

  const fetchDetail = useCallback(async (accountId: string) => {
    if (requestedRef.current.has(accountId)) return;
    requestedRef.current.add(accountId);
    setDetailLoading(prev => ({ ...prev, [accountId]: true }));
    try {
      const params = new URLSearchParams();
      params.append('accountId', accountId);
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
      const detail = await api.get(`/reports/income-detail?${params.toString()}`);
      setDetails(prev => ({ ...prev, [accountId]: detail }));
    } catch (err) {
      console.error('Income detail load error:', err);
      requestedRef.current.delete(accountId);
    } finally {
      setDetailLoading(prev => ({ ...prev, [accountId]: false }));
    }
  }, [filters.startDate, filters.endDate]);

  const toggleDetail = useCallback((accountId: string) => {
    const opening = !expanded[accountId];
    setExpanded(prev => ({ ...prev, [accountId]: opening }));
    if (opening) void fetchDetail(accountId);
  }, [expanded, fetchDetail]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const exportType = (report: ReportType): string | null => {
    switch (report) {
      case 'account-statement': return 'ledger';
      case 'transaction-report': return 'transactions';
      case 'transfer-report': return 'transfers';
      case 'loading-report': return 'loading';
      case 'reversal-report': return 'reversals';
      case 'income-report': return 'income';
      default: return null;
    }
  };

  const exportCSV = async () => {
    const type = exportType(activeReport);
    if (!type || exporting) return;
    setExporting(true);
    setExportError('');
    try {
      const params = new URLSearchParams();
      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
      if (filters.accountId) params.append('accountId', filters.accountId);
      if (filters.typeId) params.append('typeId', filters.typeId);
      if (filters.status) params.append('status', filters.status);
      if (filters.providerId) params.append('providerId', filters.providerId);
      params.append('format', 'csv');
      const res = await fetch(`${API_BASE}/reports/export/${type}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('accessToken')}` }
      });
      if (!res.ok) {
        let message = `Export failed (HTTP ${res.status})`;
        try {
          const body = await res.json();
          message = body?.error?.message || body?.message || message;
        } catch { message = `Export failed (HTTP ${res.status})`; }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${type}_export.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Report export error:', err);
      setExportError(err instanceof Error ? err.message : 'Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  const reversalDrift = activeReport === 'reversal-report' && reportData?.summary
    ? (reportData.summary.reversedTotal || 0) - (reportData.summary.originalTotal || 0)
    : 0;

  const reports = [
    { id: 'consolidated' as ReportType, name: 'Consolidated Overview', icon: BarChart3, desc: 'All accounts, transactions, transfers, and loading summary' },
    { id: 'account-statement' as ReportType, name: 'Account Statement', icon: FileText, desc: 'Detailed ledger entries for a specific account' },
    { id: 'transaction-report' as ReportType, name: 'Transaction Report', icon: FileText, desc: 'Transaction history with filters' },
    { id: 'transfer-report' as ReportType, name: 'Transfer Report', icon: ArrowLeftRight, desc: 'Fund transfer history' },
    { id: 'loading-report' as ReportType, name: 'Loading Report', icon: Smartphone, desc: 'Loading sales and profit analysis' },
    { id: 'reversal-report' as ReportType, name: 'Reversal Report', icon: RotateCcw, desc: 'Reversed transactions and reversal requests' },
    { id: 'income-report' as ReportType, name: 'Income Report', icon: TrendingUp, desc: 'Fee income and loading margin earned per account' },
    { id: 'balance-reconciliation' as ReportType, name: 'Balance Reconciliation', icon: ShieldCheck, desc: 'Verify every account balance against its ledger' },
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
            <button key={r.id} onClick={() => { if (r.id !== activeReport) { setActiveReport(r.id); setReportData(null); } setExportError(''); }}
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
            <div className="flex items-start justify-between gap-4 mb-4">
              <h3 className="font-semibold">{reports.find(r => r.id === activeReport)?.name}</h3>
              <div className="text-right shrink-0">
                {exportType(activeReport) && (
                  <button onClick={exportCSV} disabled={exporting}
                    className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed">
                    <Download className="w-4 h-4" /> {exporting ? 'Exporting...' : 'Export CSV'}
                  </button>
                )}
                {exportError && <p className="text-xs text-red-600 mt-1 max-w-[22rem]">{exportError}</p>}
              </div>
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
              {(activeReport === 'account-statement' || activeReport === 'transaction-report' || activeReport === 'reversal-report' || activeReport === 'income-report') && (
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
                  <p className="text-sm text-gray-500">Service Charges: {formatCurrency(reportData.transfers?.totalFees || 0)}</p>
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
                <div className="flex items-start justify-between gap-4 mb-3">
                  <h4 className="font-medium">{reportData.account?.name} — Account Statement</h4>
                  <span className={`text-xs font-medium px-2 py-1 rounded-full ${reportData.reconciled ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {reportData.reconciled ? 'Reconciled' : `Out of balance by ${formatCurrency(Math.abs(reportData.reconciliationGap || 0))}`}
                  </span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div><p className="text-gray-500">Opening Balance</p><p className="font-bold">{formatCurrency(reportData.openingBalance || 0)}</p></div>
                  <div><p className="text-gray-500">Total In</p><p className="font-bold text-finance-green">{formatCurrency(reportData.summary?.totalIn || 0)}</p></div>
                  <div><p className="text-gray-500">Total Out</p><p className="font-bold text-finance-red">{formatCurrency(reportData.summary?.totalOut || 0)}</p></div>
                  <div><p className="text-gray-500">Net Movement</p><p className="font-bold">{formatCurrency(reportData.summary?.netMovement || 0)}</p></div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mt-3">
                  <div><p className="text-gray-500">Statement Closes</p><p className="font-bold">{formatCurrency(reportData.closingBalance || 0)}</p></div>
                  <div><p className="text-gray-500">Current Balance</p><p className="font-bold">{formatCurrency(reportData.summary?.currentBalance || 0)}</p></div>
                  <div><p className="text-gray-500">Entries</p><p className="font-bold">{reportData.summary?.entryCount || 0}</p></div>
                  <div><p className="text-gray-500">Account</p><p className="font-bold">{reportData.account?.masked_account_number || reportData.account?.account_reference || '—'}</p></div>
                </div>
              </div>
              <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1450px]">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Date</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Txn #</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Reference</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Type</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Description</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Customer</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Reason</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Credit</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Debit</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Fee</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Charges</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {reportData.entries.map((e: any) => {
                        const isReversed = e.statement_status === 'reversed';
                        const isCompensating = Boolean(e.is_compensating);
                        return (
                        <tr key={e.id} id={e.transaction_id ? `entry-${e.transaction_id}` : undefined} className={isReversed ? 'bg-amber-50 hover:bg-amber-100' : isCompensating ? 'bg-green-50 hover:bg-green-100' : 'hover:bg-gray-50'}>
                          <td className="px-4 py-3.5 text-sm whitespace-nowrap">{new Date(e.entry_date).toLocaleDateString()}</td>
                          <td className="px-4 py-3.5 text-sm font-mono whitespace-nowrap">
                            <a
                              href={isReversed && e.reversal_resolves_to ? `#entry-${e.reversal_resolves_to}` : undefined}
                              onClick={isReversed && e.reversal_resolves_to ? () => document.getElementById(`entry-${e.reversal_resolves_to}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) : undefined}
                              className={isReversed && e.reversal_resolves_to ? 'text-gray-900 underline decoration-dotted hover:text-amber-700 cursor-pointer' : ''}
                            >
                              {e.number_display || '—'}
                            </a>
                          </td>
                          <td className="px-4 py-3.5 text-sm font-mono whitespace-nowrap">{e.reference_display || '—'}</td>
                          <td className="px-4 py-3.5 whitespace-nowrap">
                            <span
                              title={isCompensating ? `${e.type_name || 'Adjustment'} #${e.transaction_number}` : undefined}
                              className={`text-xs font-medium ${e.entry_type === 'credit' ? 'text-green-600' : 'text-red-600'}`}
                            >
                              {e.type_display || e.type_name || e.entry_type}
                            </span>
                          </td>
                          <td className="px-4 py-3.5 text-sm">
                            {isCompensating
                              ? <>Reversal of <span className="font-medium">{e.reverses_type_name || 'Transaction'} #{e.reverses_number}</span></>
                              : (e.description || e.transaction_description || e.display_name || '—')}
                            {isReversed && !isCompensating && e.reversal_reference && (
                              <div className="text-xs text-amber-600 mt-0.5">Reversed by {e.reversal_reference}</div>
                            )}
                          </td>
                          <td className="px-4 py-3.5 text-sm whitespace-nowrap">{e.customer_name || '—'}</td>
                          <td className="px-4 py-3.5 whitespace-nowrap">
                            <span className={`text-xs px-1.5 py-0.5 rounded ${statusBadgeClass(e.statement_status)}`}>
                              {statementStatusLabel(e.statement_status, e.entry_source)}
                            </span>
                          </td>
                          <td className="px-4 py-3.5 text-sm text-gray-700">
                            {e.reversal_reason ? e.reversal_reason : <span className="text-gray-400">—</span>}
                          </td>
                          <td className="px-4 py-3.5 text-sm font-medium text-right whitespace-nowrap text-green-600">{e.entry_type === 'credit' ? formatCurrency(e.amount) : ''}</td>
                          <td className="px-4 py-3.5 text-sm font-medium text-right whitespace-nowrap text-red-600">{e.entry_type === 'debit' ? formatCurrency(e.amount) : ''}</td>
                          <td className="px-4 py-3.5 text-sm text-right whitespace-nowrap">{e.fee !== null && e.fee !== undefined && parseFloat(e.fee) !== 0 ? formatCurrency(e.fee) : ''}</td>
                          <td className="px-4 py-3.5 text-sm text-right whitespace-nowrap">{e.charges_total > 0 ? formatCurrency(e.charges_total) : ''}</td>
                          <td className="px-4 py-3.5 text-sm font-medium text-right whitespace-nowrap">{formatCurrency(e.balance_after)}</td>
                        </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-gray-100 border-t-2 border-gray-300">
                      <tr className="font-bold">
                        <td className="px-4 py-3.5 text-sm" colSpan={8}>Total ({reportData.entries.length} entries)</td>
                        <td className="px-4 py-3.5 text-sm text-right text-green-600">{formatCurrency(reportData.entries.filter((e: any) => e.entry_type === 'credit').reduce((sum: number, e: any) => sum + parseFloat(e.amount), 0))}</td>
                        <td className="px-4 py-3.5 text-sm text-right text-red-600">{formatCurrency(reportData.entries.filter((e: any) => e.entry_type === 'debit').reduce((sum: number, e: any) => sum + parseFloat(e.amount), 0))}</td>
                        <td className="px-4 py-3.5 text-sm text-right">{formatCurrency(reportData.entries.reduce((sum: number, e: any) => sum + (parseFloat(e.fee) || 0), 0))}</td>
                        <td className="px-4 py-3.5 text-sm text-right">{formatCurrency(reportData.entries.reduce((sum: number, e: any) => sum + (e.charges_total || 0), 0))}</td>
                        <td className="px-4 py-3.5 text-sm text-right">{reportData.entries.length > 0 ? formatCurrency(reportData.entries[reportData.entries.length - 1].balance_after) : '₱0.00'}</td>
                      </tr>
                    </tfoot>
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
                  <div><p className="text-gray-500">Total Service Charges</p><p className="font-bold">{formatCurrency(reportData.summary?.totalFees || 0)}</p></div>
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
                        <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Service Charge</th>
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
          ) : activeReport === 'balance-reconciliation' && reportData.accounts ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div className="card"><p className="text-gray-500">Accounts</p><p className="text-2xl font-bold mt-1">{reportData.summary?.totalAccounts || 0}</p></div>
                <div className="card"><p className="text-gray-500">Reconciled</p><p className="text-2xl font-bold mt-1 text-finance-green">{reportData.summary?.reconciled || 0}</p></div>
                <div className="card"><p className="text-gray-500">Mismatched</p><p className={`text-2xl font-bold mt-1 ${reportData.summary?.mismatched ? 'text-finance-red' : ''}`}>{reportData.summary?.mismatched || 0}</p></div>
                <div className="card"><p className="text-gray-500">Broken Chain Links</p><p className={`text-2xl font-bold mt-1 ${reportData.summary?.brokenChainLinks ? 'text-finance-red' : ''}`}>{reportData.summary?.brokenChainLinks || 0}</p></div>
              </div>
              <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1000px]">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Account</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Opening</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Ledger Net</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Expected</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actual</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Gap</th>
                        <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Entries</th>
                        <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Broken</th>
                        <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Unlinked</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {reportData.accounts.map((a: any) => (
                        <tr key={a.id} className={`hover:bg-gray-50 ${a.reconciled ? '' : 'bg-red-50'}`}>
                          <td className="px-4 py-3.5 text-sm font-medium whitespace-nowrap">{a.name}</td>
                          <td className="px-4 py-3.5 text-sm text-right whitespace-nowrap">{formatCurrency(a.openingBalance)}</td>
                          <td className="px-4 py-3.5 text-sm text-right whitespace-nowrap">{formatCurrency(a.netMovement)}</td>
                          <td className="px-4 py-3.5 text-sm text-right whitespace-nowrap">{formatCurrency(a.expectedBalance)}</td>
                          <td className="px-4 py-3.5 text-sm text-right whitespace-nowrap">{formatCurrency(a.currentBalance)}</td>
                          <td className={`px-4 py-3.5 text-sm font-medium text-right whitespace-nowrap ${a.gap ? 'text-finance-red' : 'text-gray-400'}`}>{a.gap ? formatCurrency(a.gap) : '—'}</td>
                          <td className="px-4 py-3.5 text-sm text-center">{a.entryCount}</td>
                          <td className={`px-4 py-3.5 text-sm text-center ${a.chainBreaks ? 'text-finance-red font-bold' : 'text-gray-400'}`}>{a.chainBreaks}</td>
                          <td className={`px-4 py-3.5 text-sm text-center ${a.unlinkedEntries ? 'text-amber-600' : 'text-gray-400'}`}>{a.unlinkedEntries}</td>
                          <td className="px-4 py-3.5 text-sm">
                            {a.reconciled
                              ? <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">OK</span>
                              : <span className="text-xs text-finance-red">{a.issues.join('; ')}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : activeReport === 'income-report' && reportData.rows ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
                <div className="card">
                  <p className="text-gray-500">Total Income</p>
                  <p className="text-2xl font-bold mt-1 text-finance-green">{formatCurrency(reportData.summary?.totalIncome || 0)}</p>
                  <p className="text-sm text-gray-500">Fee income plus loading margin</p>
                </div>
                <div className="card">
                  <p className="text-gray-500">Fee Income</p>
                  <p className="text-2xl font-bold mt-1">{formatCurrency(reportData.summary?.feeIncome || 0)}</p>
                  <p className="text-sm text-gray-500">Fees {formatCurrency(reportData.summary?.txnFees || 0)} · Charges {formatCurrency(reportData.summary?.additionalCharges || 0)} · Transfers {formatCurrency(reportData.summary?.transferFees || 0)}</p>
                </div>
                <div className="card">
                  <p className="text-gray-500">Loading Margin</p>
                  <p className="text-2xl font-bold mt-1">{formatCurrency(reportData.summary?.loadMargin || 0)}</p>
                  <p className="text-sm text-gray-500">Revenue {formatCurrency(reportData.summary?.loadRevenue || 0)} − Cost {formatCurrency(reportData.summary?.loadCost || 0)}</p>
                </div>
                <div className="card">
                  <p className="text-gray-500">Excluded as Reversed</p>
                  <p className="text-2xl font-bold mt-1 text-amber-600">{formatCurrency(reportData.summary?.reversedExcluded || 0)}</p>
                  <p className="text-sm text-gray-500">Refunded when the transaction was reversed</p>
                </div>
              </div>

              <div className="card overflow-hidden">
                <div className="px-4 pt-4 pb-1">
                  <h4 className="font-medium">Income by Account</h4>
                  <p className="text-xs text-gray-500">
                    {reportData.summary?.accounts || 0} accounts · {reportData.summary?.earningAccounts || 0} with income · {reportData.summary?.txnCount || 0} transactions, {reportData.summary?.transferCount || 0} transfers, {reportData.summary?.loadCount || 0} loadings · largest first · click an account to see the transactions behind its figures
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1450px]">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Account</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Provider</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Type</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Txns</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Transfers</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Loadings</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Txn Fees</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Charges</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Transfer Fees</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Fee Income</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Loading Margin</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Total Income</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Reversed (Excl.)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {reportData.rows.length === 0 ? (
                        <tr><td colSpan={13} className="px-4 py-8 text-center text-sm text-gray-500">No accounts for these filters.</td></tr>
                      ) : reportData.rows.map((r: any) => {
                        const isOpen = !!expanded[r.accountId];
                        return (
                          <Fragment key={r.accountId}>
                            <tr className="hover:bg-gray-50">
                              <td className="px-4 py-3.5 text-sm font-medium whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => toggleDetail(r.accountId)}
                                  aria-expanded={isOpen}
                                  title={isOpen ? 'Hide transactions' : 'Show transactions'}
                                  className="inline-flex items-center gap-1.5 -ml-1 rounded px-1 py-0.5 text-left hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
                                >
                                  <ChevronRight className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                                  <span>{r.accountName}</span>
                                </button>
                              </td>
                              <td className="px-4 py-3.5 text-sm text-gray-600 whitespace-nowrap">{r.providerName || '—'}</td>
                              <td className="px-4 py-3.5 text-sm text-gray-600 whitespace-nowrap">{r.accountType || '—'}</td>
                              <td className="px-4 py-3.5 text-sm text-right text-gray-600">{r.txnCount}</td>
                              <td className="px-4 py-3.5 text-sm text-right text-gray-600">{r.transferCount}</td>
                              <td className="px-4 py-3.5 text-sm text-right text-gray-600">{r.loadCount}</td>
                              <td className="px-4 py-3.5 text-sm text-right font-mono">{formatCurrency(r.txnFees)}</td>
                              <td className="px-4 py-3.5 text-sm text-right font-mono">{formatCurrency(r.additionalCharges)}</td>
                              <td className="px-4 py-3.5 text-sm text-right font-mono">{formatCurrency(r.transferFees)}</td>
                              <td className="px-4 py-3.5 text-sm text-right font-mono">{formatCurrency(r.feeIncome)}</td>
                              <td className="px-4 py-3.5 text-sm text-right font-mono">{formatCurrency(r.loadMargin)}</td>
                              <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold text-finance-green">{formatCurrency(r.totalIncome)}</td>
                              <td className="px-4 py-3.5 text-sm text-right font-mono text-amber-600">{r.reversedExcluded > 0 ? formatCurrency(r.reversedExcluded) : '—'}</td>
                            </tr>
                            {isOpen && (
                              <tr className="bg-gray-50">
                                <td colSpan={13} className="border-t border-gray-200 px-4 pb-5 pt-1">
                                  {detailLoading[r.accountId] ? (
                                    <p className="py-4 text-center text-sm text-gray-500">Loading transactions…</p>
                                  ) : details[r.accountId] ? (
                                    <IncomeDetailPanel
                                      detail={details[r.accountId]}
                                      tab={detailTabs[r.accountId] || 'cash'}
                                      onTab={tab => setDetailTabs(prev => ({ ...prev, [r.accountId]: tab }))}
                                      parent={r}
                                    />
                                  ) : (
                                    <p className="py-4 text-center text-sm text-amber-600">
                                      Transactions could not be loaded. Collapse and expand this row to retry.
                                    </p>
                                  )}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                    {reportData.rows.length > 0 && (
                      <tfoot className="bg-gray-50 border-t border-gray-200">
                        <tr>
                          <td className="px-4 py-3.5 text-sm font-semibold whitespace-nowrap" colSpan={6}>Total ({reportData.summary?.accounts || 0} accounts)</td>
                          <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold">{formatCurrency(reportData.summary?.txnFees || 0)}</td>
                          <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold">{formatCurrency(reportData.summary?.additionalCharges || 0)}</td>
                          <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold">{formatCurrency(reportData.summary?.transferFees || 0)}</td>
                          <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold">{formatCurrency(reportData.summary?.feeIncome || 0)}</td>
                          <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold">{formatCurrency(reportData.summary?.loadMargin || 0)}</td>
                          <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold text-finance-green">{formatCurrency(reportData.summary?.totalIncome || 0)}</td>
                          <td className="px-4 py-3.5 text-sm text-right font-mono font-semibold text-amber-600">{formatCurrency(reportData.summary?.reversedExcluded || 0)}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
            </div>
          ) : activeReport === 'reversal-report' && reportData.reversals ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
                <div className="card">
                  <p className="text-gray-500">Reversed Transactions</p>
                  <p className="text-2xl font-bold mt-1">{reportData.summary?.reversedCount || 0}</p>
                  <p className="text-sm text-gray-500">Original movement: {formatCurrency(reportData.summary?.originalTotal || 0)}</p>
                </div>
                <div className="card">
                  <p className="text-gray-500">Compensating Amount</p>
                  <p className="text-2xl font-bold mt-1 text-finance-red">{formatCurrency(reportData.summary?.reversedTotal || 0)}</p>
                  {Math.abs(reversalDrift) > 0.004
                    ? <p className="text-sm text-amber-600">Off original by {formatCurrency(reversalDrift)}</p>
                    : <p className="text-sm text-gray-500">Matches original movement</p>}
                </div>
                <div className="card">
                  <p className="text-gray-500">Reversal Requests</p>
                  <p className="text-2xl font-bold mt-1">{reportData.summary?.requestCount || 0}</p>
                  <p className="text-sm text-gray-500">{reportData.summary?.approvedRequests || 0} approved · {reportData.summary?.rejectedRequests || 0} rejected</p>
                </div>
                <div className="card">
                  <p className="text-gray-500">Awaiting Approval</p>
                  <p className={`text-2xl font-bold mt-1 ${reportData.summary?.pendingRequests ? 'text-amber-600' : ''}`}>{reportData.summary?.pendingRequests || 0}</p>
                  <p className="text-sm text-gray-500">{formatCurrency(reportData.summary?.pendingRequestAmount || 0)}</p>
                </div>
              </div>

              <div className="card overflow-hidden">
                <div className="px-4 pt-4 pb-1">
                  <h4 className="font-medium">Reversed Transactions</h4>
                  <p className="text-xs text-gray-500">The original movement against the compensating entry that replaced it</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1100px]">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">#</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Account</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Type</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Original</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Reversed</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Reason</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Requested By</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Approved By</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Reversal</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Reversed On</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {reportData.reversals.length === 0 ? (
                        <tr><td colSpan={10} className="px-4 py-8 text-center text-sm text-gray-500">No reversed transactions for these filters.</td></tr>
                      ) : reportData.reversals.map((r: any) => (
                        <tr key={r.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3.5 font-mono text-sm whitespace-nowrap">{r.transactionNumber}</td>
                          <td className="px-4 py-3.5 text-sm whitespace-nowrap">{r.accountName}</td>
                          <td className="px-4 py-3.5 text-sm whitespace-nowrap">{r.typeName}</td>
                          <td className="px-4 py-3.5 text-sm text-right whitespace-nowrap">
                            <span className="text-xs font-medium uppercase tracking-wide text-gray-500 mr-1.5">{sideLabel(r.originalEntryType)}</span>
                            <span className={`font-medium ${sideClass(r.originalEntryType)}`}>{formatCurrency(r.originalTotal)}</span>
                          </td>
                          <td className="px-4 py-3.5 text-sm text-right whitespace-nowrap">
                            {r.reversedAmount === null
                              ? <span className="text-xs font-medium text-finance-red">No entry</span>
                              : <>
                                  <span className="text-xs font-medium uppercase tracking-wide text-gray-500 mr-1.5">{sideLabel(r.reversalEntryType)}</span>
                                  <span className={`font-medium ${sideClass(r.reversalEntryType)}`}>{formatCurrency(r.reversedAmount)}</span>
                                </>}
                          </td>
                          <td className="px-4 py-3.5 text-sm text-gray-700">{r.reason || <span className="text-gray-400">—</span>}</td>
                          <td className="px-4 py-3.5 text-sm whitespace-nowrap">{r.requestedBy || <span className="text-gray-400">—</span>}</td>
                          <td className="px-4 py-3.5 text-sm whitespace-nowrap">{r.approvedBy || <span className="text-gray-400">—</span>}</td>
                          <td className="px-4 py-3.5 text-sm whitespace-nowrap">
                            <div className="font-mono text-xs">{r.reversalNumber ? `REV-${r.reversalNumber}` : '—'}</div>
                            <span className={`text-xs px-1.5 py-0.5 rounded ${r.requestStatus === 'approved' ? 'bg-green-100 text-green-700' : r.requestStatus === 'pending' ? 'bg-amber-100 text-amber-700' : r.requestStatus === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                              {r.requestStatus || 'direct'}
                            </span>
                          </td>
                          <td className="px-4 py-3.5 text-sm whitespace-nowrap">{r.reversedAt ? new Date(r.reversedAt).toLocaleDateString() : <span className="text-gray-400">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card overflow-hidden">
                <div className="px-4 pt-4 pb-1">
                  <h4 className="font-medium">Reversal Requests</h4>
                  <p className="text-xs text-gray-500">Every reversal requested for these transactions, approved or not</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1000px]">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">#</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Account</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Amount</th>
                        <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Reason</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Requested By</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Decided By</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Requested On</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Decided On</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {reportData.requests.length === 0 ? (
                        <tr><td colSpan={9} className="px-4 py-8 text-center text-sm text-gray-500">No reversal requests for these filters.</td></tr>
                      ) : reportData.requests.map((q: any) => (
                        <tr key={q.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3.5 font-mono text-sm whitespace-nowrap">{q.transactionNumber ?? '—'}</td>
                          <td className="px-4 py-3.5 text-sm whitespace-nowrap">{q.accountName || '—'}</td>
                          <td className="px-4 py-3.5 text-sm font-medium text-right whitespace-nowrap">{formatCurrency(q.amount)}</td>
                          <td className="px-4 py-3.5 text-center">
                            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${q.status === 'approved' ? 'bg-green-100 text-green-700' : q.status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                              {q.status}
                            </span>
                          </td>
                          <td className="px-4 py-3.5 text-sm text-gray-700">{q.reason || <span className="text-gray-400">—</span>}</td>
                          <td className="px-4 py-3.5 text-sm whitespace-nowrap">{q.requestedBy || <span className="text-gray-400">—</span>}</td>
                          <td className="px-4 py-3.5 text-sm whitespace-nowrap">{q.approvedBy || <span className="text-gray-400">—</span>}</td>
                          <td className="px-4 py-3.5 text-sm whitespace-nowrap">{q.requestedAt ? new Date(q.requestedAt).toLocaleDateString() : '—'}</td>
                          <td className="px-4 py-3.5 text-sm whitespace-nowrap">{q.decidedAt && q.status !== 'pending' ? new Date(q.decidedAt).toLocaleDateString() : '—'}</td>
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
