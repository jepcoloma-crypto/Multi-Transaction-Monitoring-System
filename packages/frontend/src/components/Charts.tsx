import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { formatCurrency } from '../lib/format';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell } from 'recharts';

interface TrendData {
  date: string; account_name: string; credits: string; debits: string; closing_balance: string;
}

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'];

export function BalanceTrendChart({ accountId }: { accountId?: string }) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const params = accountId ? `?accountId=${accountId}&days=30` : '?days=30';
        const res = await api.get<TrendData[]>(`/reports/balance-trends${params}`);
        const grouped: Record<string, any> = {};
        res.forEach((d: TrendData) => {
          const date = new Date(d.date).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
          if (!grouped[date]) grouped[date] = { date };
          grouped[date][d.account_name] = parseFloat(d.closing_balance);
        });
        setData(Object.values(grouped));
      } catch {} finally { setLoading(false); }
    };
    fetchData();
  }, [accountId]);

  if (loading) return <div className="h-64 flex items-center justify-center text-gray-400">Loading chart...</div>;
  if (data.length === 0) return <div className="h-64 flex items-center justify-center text-gray-400">No data</div>;

  const accounts = [...new Set(data.flatMap(d => Object.keys(d).filter(k => k !== 'date')))];

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="date" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} tickFormatter={v => `₱${(v/1000).toFixed(0)}k`} />
        <Tooltip formatter={(v: any) => [formatCurrency(parseFloat(v)), '']} />
        <Legend />
        {accounts.map((acc, i) => (
          <Line key={acc} type="monotone" dataKey={acc} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function IncomeExpenseChart() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await api.get<TrendData[]>('/reports/balance-trends?days=30');
        const grouped: Record<string, { date: string; income: number; expense: number }> = {};
        res.forEach((d: TrendData) => {
          const date = new Date(d.date).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
          if (!grouped[date]) grouped[date] = { date, income: 0, expense: 0 };
          grouped[date].income += parseFloat(d.credits);
          grouped[date].expense += parseFloat(d.debits);
        });
        setData(Object.values(grouped));
      } catch {} finally { setLoading(false); }
    };
    fetchData();
  }, []);

  if (loading) return <div className="h-64 flex items-center justify-center text-gray-400">Loading chart...</div>;
  if (data.length === 0) return <div className="h-64 flex items-center justify-center text-gray-400">No data</div>;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="date" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} tickFormatter={v => `₱${(v/1000).toFixed(0)}k`} />
        <Tooltip formatter={(v: any) => [formatCurrency(parseFloat(v)), '']} />
        <Legend />
        <Bar dataKey="income" fill="#10B981" name="Income" radius={[4, 4, 0, 0]} />
        <Bar dataKey="expense" fill="#EF4444" name="Expense" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function AccountDistributionChart() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await api.get<{ accounts: any[] }>('/balances');
        setData(res.accounts.map((a: any) => ({ name: a.name, value: parseFloat(a.current_balance) })));
      } catch {} finally { setLoading(false); }
    };
    fetchData();
  }, []);

  if (loading) return <div className="h-64 flex items-center justify-center text-gray-400">Loading chart...</div>;
  if (data.length === 0) return <div className="h-64 flex items-center justify-center text-gray-400">No data</div>;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie data={data} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Pie>
        <Tooltip formatter={(v: any) => formatCurrency(parseFloat(v))} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function MonthlyComparisonChart() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await api.get<TrendData[]>('/reports/balance-trends?days=90');
        const monthly: Record<string, { month: string; inflow: number; outflow: number; net: number }> = {};
        res.forEach((d: TrendData) => {
          const month = new Date(d.date).toLocaleDateString('en-PH', { month: 'short', year: '2-digit' });
          if (!monthly[month]) monthly[month] = { month, inflow: 0, outflow: 0, net: 0 };
          const inflow = parseFloat(d.credits);
          const outflow = parseFloat(d.debits);
          monthly[month].inflow += inflow;
          monthly[month].outflow += outflow;
          monthly[month].net += inflow - outflow;
        });
        setData(Object.values(monthly));
      } catch {} finally { setLoading(false); }
    };
    fetchData();
  }, []);

  if (loading) return <div className="h-64 flex items-center justify-center text-gray-400">Loading chart...</div>;
  if (data.length === 0) return <div className="h-64 flex items-center justify-center text-gray-400">No data</div>;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="month" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} tickFormatter={v => `₱${(v/1000).toFixed(0)}k`} />
        <Tooltip formatter={(v: any) => [formatCurrency(parseFloat(v)), '']} />
        <Legend />
        <Bar dataKey="inflow" fill="#10B981" name="Inflow" radius={[4, 4, 0, 0]} />
        <Bar dataKey="outflow" fill="#EF4444" name="Outflow" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
