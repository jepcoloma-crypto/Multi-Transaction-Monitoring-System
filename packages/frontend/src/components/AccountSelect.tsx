import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatCurrency } from '../lib/format';

export interface AccountOption {
  id: string;
  name: string;
  provider_name?: string | null;
  masked_account_number?: string | null;
  /**
   * Absent for cross-branch destination candidates, which are name-only by
   * design. Arrives as a string: node-postgres hands numeric columns back as
   * text and no type parser is installed, so a number here is the exception.
   */
  current_balance?: number | string | null;
  /** Two branches can hold an identically named account; without this the picker is ambiguous. */
  branch_name?: string | null;
  /** `account_types.code` — the only thing that says which accounts are drawers. */
  type_code?: string | null;
}

// Reads either shape and refuses to invent a zero: an account with no balance
// on it (a cross-branch destination) must show nothing rather than ₱0.00,
// which would read as a claim about money the picker was deliberately kept
// from disclosing.
const balanceOf = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function AccountLabel({ account }: { account: AccountOption }) {
  const balance = balanceOf(account.current_balance);
  return (
    <>
      <strong className="font-semibold">{account.name}</strong>
      {account.provider_name && (
        <>
          {' '}
          (<em className="italic">{account.provider_name}</em>
          {account.masked_account_number ? ` · ${account.masked_account_number}` : ''})
        </>
      )}
      {balance !== null && (
        <> - <em className="italic">{formatCurrency(balance)}</em></>
      )}
      {account.branch_name && (
        <span className="text-gray-400"> · {account.branch_name}</span>
      )}
    </>
  );
}

// Matching runs over everything the row shows, not just the name: an
// operator who half-remembers "the GCash one ending 1234" should land on it,
// and the branch is what separates two identically named accounts.
export const accountMatches = (account: AccountOption, rawQuery: string): boolean => {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  return [account.name, account.provider_name, account.masked_account_number, account.branch_name]
    .some((field) => (field ?? '').toLowerCase().includes(query));
};

interface AccountSelectProps {
  accounts: AccountOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  className?: string;
}

export default function AccountSelect({ accounts, value, onChange, placeholder, className }: AccountSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = accounts.find((a) => a.id === value);

  const visible = accounts.filter((a) => accountMatches(a, query));

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // Typing is the first thing anyone does with a list this long, so the box
  // takes focus as the panel opens.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Reopening starts from the whole list. A query left behind would present a
  // narrowed list with nothing on screen explaining why it is narrowed.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter picks the only sensible row left on screen. Stopping it here also
    // keeps it from reaching the surrounding form as a submit — this picker
    // sits inside the New Transaction form, where an accidental submit would
    // post a transaction.
    if (e.key === 'Enter') {
      e.preventDefault();
      if (visible.length > 0) choose(visible[0].id);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`${className || 'input-field'} flex items-center justify-between text-left`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">
          {selected ? <AccountLabel account={selected} /> : <span className="text-gray-400">{placeholder}</span>}
        </span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-gray-400" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-300 bg-white shadow-lg">
          {accounts.length > 0 && (
            <div className="border-b border-gray-100 p-2">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search accounts…"
                aria-label="Search accounts"
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-primary-500 focus:outline-none"
              />
            </div>
          )}
          <ul role="listbox" className="max-h-60 overflow-y-auto py-1">
            {accounts.length === 0 ? (
              <li className="px-3 py-2 text-sm text-gray-500">No active accounts</li>
            ) : visible.length === 0 ? (
              <li className="px-3 py-2 text-sm text-gray-500">No accounts match</li>
            ) : (
              visible.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => choose(a.id)}
                    className={`block w-full px-3 py-2 text-left text-sm hover:bg-primary-50 ${a.id === value ? 'bg-primary-50' : ''}`}
                  >
                    <AccountLabel account={a} />
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
