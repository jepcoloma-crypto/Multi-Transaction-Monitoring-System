import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { Wallet, TrendingUp, TrendingDown, ArrowUpDown, AlertTriangle, ArrowRight, ArrowLeftRight, Smartphone, RefreshCw, Calendar } from 'lucide-react';
import { Link } from 'react-router-dom';
import { BalanceTrendChart, IncomeExpenseChart, AccountDistributionChart, MonthlyComparisonChart } from '../components/Charts';

interface BalanceData {
  totalBalance: number; accountCount: number;
  accounts: Array<{ id: string; name: string; current_balance: number; minimum_balance: number; provider_name: string; type_name: string; status: string; }>;
}
interface TxSummary { totalMoneyIn: number; totalMoneyOut: number; totalFees: number; transactionCount: number; netMovement: number; }
interface TransferSummary { totalTransfers: number; totalAmount: number; totalFees: number; }
interface LoadingSummary { totalSales: number; totalRevenue: number; totalCost: number; totalProfit: number; }
interface TodaySummary { transactionCount: number; moneyIn: number; moneyOut: number; feesCollected: number; completedCount: number; pendingCount: number; reversedCount: number; }

export default function Dashboard() {
  const [balances, setBalances] = useState<BalanceData | null>(null);
  const [txSummary, setTxSummary] = useState<TxSummary | null>(null);
  const [transferSummary, setTransferSummary] = useState<TransferSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState<LoadingSummary | null>(null);
  const [todaySummary, setTodaySummary] = useState<TodaySummary | null>(null);
  const [recentTransactions, setRecentTransactions] = useState<any[]>([]);
  const [recentTransfers, setRecentTransfers] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const [bal, txs, recent, ts, ls, rt, al, today] = await Promise.allSettled([
        api.get<BalanceData>('/balances'),
        api.get<{ summary: TxSummary }>('/transactions/summary'),
        api.get<{ data: any[] }>('/transactions?limit=8'),
        api.get<TransferSummary>('/transfers/summary'),
        api.get<{ summary: LoadingSummary }>('/loading/summary'),
        api.get<{ data: any[] }>('/transfers?limit=5'),
        api.get<{ data: any[]; unreadCount: number }>('/alerts?limit=5'),
        api.get<{ data: TodaySummary }>('/transactions/today'),
      ]);
      if (bal.status === 'fulfilled') setBalances(bal.value);
      if (txs.status === 'fulfilled') setTxSummary(txs.value.summary);
      if (recent.status === 'fulfilled') setRecentTransactions(recent.value.data);
      if (ts.status === 'fulfilled') setTransferSummary(ts.value);
      if (ls.status === 'fulfilled') setLoadingSummary(ls.value.summary);
      if (rt.status === 'fulfilled') setRecentTransfers(rt.value.data);
      if (al.status === 'fulfilled') { setAlerts(al.value.data); setUnreadAlerts(al.value.unreadCount); }
      if (today.status === 'fulfilled') setTodaySummary(today.value.data);
      setLastRefresh(new Date());
    } catch (err) { console.error('Dashboard load error:', err); } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const formatTime = (d: Date) => d.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const lowBalanceAccounts = balances?.accounts.filter(a => a.status === 'active' && a.current_balance <= a.minimum_balance) || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Dashboard</h2>
          <p className="text-xs text-gray-500">Last refreshed: {formatTime(lastRefresh)}</p>
        </div>
        <button onClick={() => fetchData(true)} disabled={refreshing}
          className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600">Total Controlled Funds</p>
              <p className="text-2xl font-bold text-gray-900 mt-1">{loading ? '...' : formatCurrency(balances?.totalBalance || 0)}</p>
            </div>
            <div className="w-12 h-12 bg-primary-100 rounded-lg flex items-center justify-center"><Wallet className="w-6 h-6 text-primary-600" /></div>
          </div>
          <p className="text-xs text-gray-500 mt-2">{balances?.accountCount || 0} active accounts</p>
        </div>
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600">Money In</p>
              <p className="text-2xl font-bold text-finance-green mt-1">{loading ? '...' : formatCurrency(txSummary?.totalMoneyIn || 0)}</p>
            </div>
            <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center"><TrendingUp className="w-6 h-6 text-finance-green" /></div>
          </div>
          <p className="text-xs text-gray-500 mt-2">{txSummary?.transactionCount || 0} transactions</p>
        </div>
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600">Money Out</p>
              <p className="text-2xl font-bold text-finance-red mt-1">{loading ? '...' : formatCurrency(txSummary?.totalMoneyOut || 0)}</p>
            </div>
            <div className="w-12 h-12 bg-red-100 rounded-lg flex items-center justify-center"><TrendingDown className="w-6 h-6 text-finance-red" /></div>
          </div>
          <p className="text-xs text-gray-500 mt-2">Fees: {formatCurrency(txSummary?.totalFees || 0)}</p>
        </div>
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600">Net Movement</p>
              <p className={`text-2xl font-bold mt-1 ${(txSummary?.netMovement || 0) >= 0 ? 'text-finance-green' : 'text-finance-red'}`}>
                {loading ? '...' : formatCurrency(txSummary?.netMovement || 0)}
              </p>
            </div>
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center"><ArrowUpDown className="w-6 h-6 text-finance-blue" /></div>
          </div>
          <p className="text-xs text-gray-500 mt-2">Inflow minus outflow</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {transferSummary && (
          <div className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Fund Transfers</p>
                <p className="text-xl font-bold text-gray-900 mt-1">{transferSummary.totalTransfers}</p>
              </div>
              <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center"><ArrowLeftRight className="w-5 h-5 text-purple-600" /></div>
            </div>
            <p className="text-xs text-gray-500 mt-2">Total: {formatCurrency(transferSummary.totalAmount)} | Fees: {formatCurrency(transferSummary.totalFees)}</p>
          </div>
        )}
        {loadingSummary && (
          <div className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Loading Profit</p>
                <p className="text-xl font-bold text-finance-green mt-1">{formatCurrency(loadingSummary.totalProfit)}</p>
              </div>
              <div className="w-10 h-10 bg-orange-100 rounded-lg flex items-center justify-center"><Smartphone className="w-5 h-5 text-orange-600" /></div>
            </div>
            <p className="text-xs text-gray-500 mt-2">{loadingSummary.totalSales} sales | Revenue: {formatCurrency(loadingSummary.totalRevenue)}</p>
          </div>
        )}
      </div>

      {/* Today's Summary */}
      {todaySummary && (
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Calendar className="w-4 h-4 text-primary-600" />
            <h3 className="text-sm font-semibold text-gray-900">Today's Summary</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-gray-500">Transactions</p>
              <p className="text-lg font-bold">{todaySummary.transactionCount}</p>
              <p className="text-xs text-gray-400">{todaySummary.completedCount} completed, {todaySummary.pendingCount} pending</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Money In</p>
              <p className="text-lg font-bold text-finance-green">{formatCurrency(todaySummary.moneyIn)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Money Out</p>
              <p className="text-lg font-bold text-finance-red">{formatCurrency(todaySummary.moneyOut)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Fees Collected</p>
              <p className="text-lg font-bold text-yellow-600">{formatCurrency(todaySummary.feesCollected)}</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-base font-semibold text-gray-900 mb-3">Balance Trends (30 Days)</h3>
          <BalanceTrendChart />
        </div>
        <div className="card">
          <h3 className="text-base font-semibold text-gray-900 mb-3">Account Distribution</h3>
          <AccountDistributionChart />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-base font-semibold text-gray-900 mb-3">Daily Income vs Expense</h3>
          <IncomeExpenseChart />
        </div>
        <div className="card">
          <h3 className="text-base font-semibold text-gray-900 mb-3">Monthly Comparison (90 Days)</h3>
          <MonthlyComparisonChart />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-900">Account Balances</h3>
            <Link to="/accounts" className="text-sm text-primary-600 hover:text-primary-700 flex items-center gap-1">View all <ArrowRight className="w-4 h-4" /></Link>
          </div>
          {loading ? (
            <div className="text-center py-8 text-gray-500">Loading...</div>
          ) : !balances || balances.accounts.length === 0 ? (
            <div className="text-center py-8 text-gray-500"><Wallet className="w-12 h-12 mx-auto mb-3 opacity-50" /><p>No accounts configured yet</p></div>
          ) : (
            <div className="space-y-3">
              {balances.accounts.slice(0, 6).map((account) => (
                <div key={account.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 truncate">{account.name}</p>
                    <p className="text-xs text-gray-500">{account.provider_name} | {account.type_name}</p>
                  </div>
                  <div className="text-right ml-3">
                    <p className={`text-sm font-bold ${account.current_balance <= account.minimum_balance ? 'text-red-600' : 'text-gray-900'}`}>{formatCurrency(account.current_balance)}</p>
                    {account.current_balance <= account.minimum_balance && <p className="text-xs text-red-500">Below min</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-gray-900">Recent Transactions</h3>
            <Link to="/transactions" className="text-sm text-primary-600 hover:text-primary-700 flex items-center gap-1">View all <ArrowRight className="w-4 h-4" /></Link>
          </div>
          {loading ? (
            <div className="text-center py-8 text-gray-500">Loading...</div>
          ) : recentTransactions.length === 0 ? (
            <div className="text-center py-8 text-gray-500"><ArrowUpDown className="w-12 h-12 mx-auto mb-3 opacity-50" /><p>No transactions yet</p></div>
          ) : (
            <div className="space-y-3">
              {recentTransactions.slice(0, 6).map((tx) => (
                <div key={tx.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 truncate">{tx.type_name}</p>
                    <p className="text-xs text-gray-500">{tx.account_name} | {new Date(tx.transaction_date).toLocaleDateString()}</p>
                  </div>
                  <div className="text-right ml-3">
                    <p className={`text-sm font-bold ${tx.direction === 'in' ? 'text-green-600' : 'text-red-600'}`}>
                      {tx.direction === 'in' ? '+' : '-'}{formatCurrency(tx.amount)}
                    </p>
                    <p className={`text-xs ${tx.status === 'completed' ? 'text-green-600' : 'text-yellow-600'}`}>{tx.status}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {recentTransfers.length > 0 && (
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-gray-900">Recent Transfers</h3>
              <Link to="/transfers" className="text-sm text-primary-600 hover:text-primary-700 flex items-center gap-1">View all <ArrowRight className="w-4 h-4" /></Link>
            </div>
            <div className="space-y-3">
              {recentTransfers.map((t: any) => (
                <div key={t.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 truncate">{t.source_name} → {t.destination_name}</p>
                    <p className="text-xs text-gray-500">{new Date(t.transfer_date).toLocaleDateString()}</p>
                  </div>
                  <div className="text-right ml-3">
                    <p className="text-sm font-bold text-purple-600">{formatCurrency(t.transfer_amount)}</p>
                    <p className={`text-xs ${t.status === 'completed' ? 'text-green-600' : 'text-yellow-600'}`}>{t.status}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {alerts.length > 0 && (
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-gray-900">Recent Alerts</h3>
              <Link to="/alerts" className="text-sm text-primary-600 hover:text-primary-700 flex items-center gap-1">
                {unreadAlerts > 0 && <span className="bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5">{unreadAlerts}</span>}
                View all <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
            <div className="space-y-3">
              {alerts.slice(0, 4).map((a: any) => (
                <div key={a.id} className={`p-3 rounded-lg ${!a.is_read ? 'bg-blue-50 border-l-2 border-blue-400' : 'bg-gray-50'}`}>
                  <p className="text-sm font-medium text-gray-900">{a.title}</p>
                  {a.message && <p className="text-xs text-gray-600 mt-1 line-clamp-2">{a.message}</p>}
                  <p className="text-xs text-gray-400 mt-1">{new Date(a.created_at).toLocaleString()}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {lowBalanceAccounts.length > 0 && (
        <div className="card border-yellow-200 bg-yellow-50">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-5 h-5 text-yellow-600" />
            <h3 className="text-base font-semibold text-yellow-800">Low Balance Alerts</h3>
          </div>
          <div className="space-y-2">
            {lowBalanceAccounts.map((account) => (
              <div key={account.id} className="flex items-center justify-between text-sm">
                <span className="text-yellow-700">{account.name} ({account.provider_name})</span>
                <span className="font-medium text-yellow-800">{formatCurrency(account.current_balance)} / min: {formatCurrency(account.minimum_balance)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
