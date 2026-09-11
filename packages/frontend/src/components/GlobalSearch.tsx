import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, Wallet, ArrowLeftRight, ArrowUpDown, Smartphone, Users } from 'lucide-react';
import { api } from '../lib/api';
import { formatCurrency } from '../lib/format';

interface SearchResult {
  accounts: { id: string; name: string; masked_account_number: string; current_balance: number }[];
  transactions: { id: string; transaction_number: number; amount: number; account_name: string; type_name: string; direction: string; status: string }[];
  transfers: { id: string; transfer_number: number; transfer_amount: number; source_name: string; destination_name: string; status: string }[];
  loading: { id: string; transaction_number: number; customer_number: string; total_revenue: number; product_name: string; status: string }[];
  users: { id: string; email: string; first_name: string; last_name: string }[];
}

export default function GlobalSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (query.trim().length < 2) { setResults(null); return; }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.get<SearchResult>(`/search?q=${encodeURIComponent(query.trim())}`);
        setResults(data);
      } catch { setResults(null); } finally { setLoading(false); }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); inputRef.current?.focus(); setOpen(true); }
      if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const goTo = (path: string) => { navigate(path); setOpen(false); setQuery(''); setResults(null); };

  const hasResults = results && (
    results.accounts.length || results.transactions.length ||
    results.transfers.length || results.loading.length || results.users.length
  );

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search... (Ctrl+K)"
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          className="w-64 pl-9 pr-8 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
        {query && (
          <button onClick={() => { setQuery(''); setResults(null); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {open && query.trim().length >= 2 && (
        <div className="absolute top-full mt-2 w-full max-w-lg bg-white rounded-xl shadow-lg border border-gray-200 z-50 max-h-[70vh] overflow-y-auto">
          {loading && <div className="p-4 text-center text-sm text-gray-500">Searching...</div>}

          {!loading && !hasResults && (
            <div className="p-4 text-center text-sm text-gray-500">No results found</div>
          )}

          {!loading && hasResults && (
            <div className="py-2">
              {results.accounts.length > 0 && (
                <div>
                  <p className="px-4 py-1 text-xs font-semibold text-gray-500 uppercase flex items-center gap-1"><Wallet className="w-3 h-3" /> Accounts</p>
                  {results.accounts.map(a => (
                    <button key={a.id} onClick={() => goTo('/accounts')} className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-center justify-between">
                      <div><p className="text-sm font-medium">{a.name}</p><p className="text-xs text-gray-500">{a.masked_account_number}</p></div>
                      <p className="text-sm font-medium">{formatCurrency(a.current_balance)}</p>
                    </button>
                  ))}
                </div>
              )}

              {results.transactions.length > 0 && (
                <div>
                  <p className="px-4 py-1 text-xs font-semibold text-gray-500 uppercase flex items-center gap-1"><ArrowLeftRight className="w-3 h-3" /> Transactions</p>
                  {results.transactions.map(t => (
                    <button key={t.id} onClick={() => goTo('/transactions')} className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-center justify-between">
                      <div><p className="text-sm font-medium">#{t.transaction_number} — {t.type_name}</p><p className="text-xs text-gray-500">{t.account_name}</p></div>
                      <p className={`text-sm font-medium ${t.direction === 'in' ? 'text-green-600' : 'text-red-600'}`}>{t.direction === 'in' ? '+' : '-'}{formatCurrency(t.amount)}</p>
                    </button>
                  ))}
                </div>
              )}

              {results.transfers.length > 0 && (
                <div>
                  <p className="px-4 py-1 text-xs font-semibold text-gray-500 uppercase flex items-center gap-1"><ArrowUpDown className="w-3 h-3" /> Transfers</p>
                  {results.transfers.map(t => (
                    <button key={t.id} onClick={() => goTo('/transfers')} className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-center justify-between">
                      <div><p className="text-sm font-medium">#{t.transfer_number}</p><p className="text-xs text-gray-500">{t.source_name} → {t.destination_name}</p></div>
                      <p className="text-sm font-medium">{formatCurrency(t.transfer_amount)}</p>
                    </button>
                  ))}
                </div>
              )}

              {results.loading.length > 0 && (
                <div>
                  <p className="px-4 py-1 text-xs font-semibold text-gray-500 uppercase flex items-center gap-1"><Smartphone className="w-3 h-3" /> Loading</p>
                  {results.loading.map(l => (
                    <button key={l.id} onClick={() => goTo('/loading')} className="w-full px-4 py-2 text-left hover:bg-gray-50 flex items-center justify-between">
                      <div><p className="text-sm font-medium">#{l.transaction_number} — {l.product_name}</p><p className="text-xs text-gray-500">{l.customer_number}</p></div>
                      <p className="text-sm font-medium">{formatCurrency(l.total_revenue)}</p>
                    </button>
                  ))}
                </div>
              )}

              {results.users.length > 0 && (
                <div>
                  <p className="px-4 py-1 text-xs font-semibold text-gray-500 uppercase flex items-center gap-1"><Users className="w-3 h-3" /> Users</p>
                  {results.users.map(u => (
                    <button key={u.id} onClick={() => goTo('/users')} className="w-full px-4 py-2 text-left hover:bg-gray-50">
                      <p className="text-sm font-medium">{u.first_name} {u.last_name}</p>
                      <p className="text-xs text-gray-500">{u.email}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
