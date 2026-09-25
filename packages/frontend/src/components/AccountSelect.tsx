import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatCurrency } from '../lib/format';

export interface AccountOption {
  id: string;
  name: string;
  provider_name?: string | null;
  masked_account_number?: string | null;
  current_balance: number;
}

function AccountLabel({ account }: { account: AccountOption }) {
  return (
    <>
      <strong className="font-semibold">{account.name}</strong>
      {account.provider_name && (
        <>
          {' '}
          (<em className="italic">{account.provider_name}</em>
          {account.masked_account_number ? ` · ${account.masked_account_number}` : ''})
        </>
      )}{' '}
      - <em className="italic">{formatCurrency(account.current_balance)}</em>
    </>
  );
}

interface AccountSelectProps {
  accounts: AccountOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  className?: string;
}

export default function AccountSelect({ accounts, value, onChange, placeholder, className }: AccountSelectProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected = accounts.find((a) => a.id === value);

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
        <ul
          role="listbox"
          className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-gray-300 bg-white py-1 shadow-lg"
        >
          {accounts.length === 0 ? (
            <li className="px-3 py-2 text-sm text-gray-500">No active accounts</li>
          ) : (
            accounts.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(a.id);
                    setOpen(false);
                  }}
                  className={`block w-full px-3 py-2 text-left text-sm hover:bg-primary-50 ${a.id === value ? 'bg-primary-50' : ''}`}
                >
                  <AccountLabel account={a} />
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
