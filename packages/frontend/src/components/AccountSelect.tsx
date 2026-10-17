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
