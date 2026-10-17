import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AccountSelect from './AccountSelect';
import type { AccountOption } from './AccountSelect';

// What /accounts actually answers with: node-postgres returns numeric columns
// as text and no type parser is installed, so the balance arrives as a string.
// The picker has to read that shape or it shows no balance at all.
const fromApi: AccountOption[] = [
  { id: 'a1', name: 'Revolving Fund Main Branch', current_balance: '99264.16', branch_name: 'Main Branch' },
  { id: 'a2', name: 'GCash', provider_name: 'GCash', masked_account_number: '****1234', current_balance: '314.00' },
  // Cross-branch destination candidates are name-only by design.
  { id: 'a3', name: 'Other Branch Float' },
];

const renderPicker = (accounts: AccountOption[], value = '') => {
  const onChange = vi.fn();
  render(<AccountSelect accounts={accounts} value={value} onChange={onChange} placeholder="Select account" />);
  // Open the list so the option rows render.
  fireEvent.click(screen.getByText('Select account'));
  return { onChange };
};

describe('AccountSelect', () => {
  it('shows the balance beside an account whose balance arrived as a string', () => {
    renderPicker(fromApi);
    expect(screen.getByText('₱99,264.16')).toBeTruthy();
    expect(screen.getByText('₱314.00')).toBeTruthy();
  });

  it('keeps the provider and masked number readable alongside the balance', () => {
    renderPicker(fromApi);
    // "GCash" is both the account name and the provider, so the name element
    // is the anchor: its button row is the one that must carry the rest.
    const name = screen.getAllByText('GCash').find((el) => el.tagName === 'STRONG')!;
    const row = name.closest('button')!;
    expect(row.textContent).toContain('****1234');
    expect(row.textContent).toContain('₱314.00');
  });

  it('shows no balance for a name-only destination rather than inventing a zero', () => {
    renderPicker(fromApi);
    const destination = screen.getByText('Other Branch Float').closest('button')!;
    expect(destination.textContent).not.toContain('₱');
  });

  it('reads a numeric balance as well as a string one', () => {
    renderPicker([{ id: 'a4', name: 'Maya', current_balance: 12830 }]);
    expect(screen.getByText('₱12,830.00')).toBeTruthy();
  });

  it('reports the chosen account by id', () => {
    const { onChange } = renderPicker(fromApi);
    fireEvent.click(screen.getByText(/Revolving Fund Main Branch/));
    expect(onChange).toHaveBeenCalledWith('a1');
  });
});
