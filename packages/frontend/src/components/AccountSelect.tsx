import { formatCurrency } from '../lib/format';
import SearchableSelect from './SearchableSelect';

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
  return (
    <SearchableSelect
      items={accounts}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={className}
      matches={accountMatches}
      renderOption={(account) => <AccountLabel account={account} />}
      searchLabel="Search accounts"
      emptyText="No active accounts"
      noMatchText="No accounts match"
    />
  );
}
