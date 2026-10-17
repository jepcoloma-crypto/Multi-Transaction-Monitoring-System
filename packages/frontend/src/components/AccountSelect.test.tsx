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

describe('AccountSelect search', () => {
  const openWithSearch = () => {
    const { onChange } = renderPicker(fromApi);
    const search = screen.getByLabelText('Search accounts') as HTMLInputElement;
    return { onChange, search };
  };

  it('takes focus when the panel opens, so typing narrows immediately', () => {
    const { search } = openWithSearch();
    expect(document.activeElement).toBe(search);
  });

  it('narrows to accounts whose name matches', () => {
    const { search } = openWithSearch();
    fireEvent.change(search, { target: { value: 'revolving' } });
    expect(screen.getByText(/Revolving Fund Main Branch/)).toBeTruthy();
    expect(screen.queryByText('GCash')).toBeNull();
  });

  it('matches on the masked number an operator half-remembers', () => {
    const { search } = openWithSearch();
    fireEvent.change(search, { target: { value: '1234' } });
    // "GCash" is both name and provider, so anchor on the name element.
    expect(screen.getAllByText('GCash').some((el) => el.tagName === 'STRONG')).toBe(true);
    expect(screen.queryByText(/Revolving Fund/)).toBeNull();
  });

  it('matches on the branch, which is what separates two identical names', () => {
    const twoBranches: AccountOption[] = [
      { id: 'b1', name: 'Drawer', current_balance: '100.00', branch_name: 'Main Branch' },
      { id: 'b2', name: 'Drawer', current_balance: '200.00', branch_name: 'Satellite' },
    ];
    renderPicker(twoBranches);
    fireEvent.change(screen.getByLabelText('Search accounts'), { target: { value: 'satellite' } });
    expect(screen.getByText(/Satellite/).closest('button')!.textContent).toContain('₱200.00');
    expect(screen.queryByText(/Main Branch/)).toBeNull();
  });

  it('says so rather than showing an empty panel when nothing matches', () => {
    const { search } = openWithSearch();
    fireEvent.change(search, { target: { value: 'nonexistent' } });
    expect(screen.getByText('No accounts match')).toBeTruthy();
  });

  it('picks the first match on Enter', () => {
    const { onChange, search } = openWithSearch();
    fireEvent.change(search, { target: { value: 'revolving' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('a1');
  });

  it('does not let Enter reach the form as a submit when nothing matches', () => {
    const { onChange, search } = openWithSearch();
    fireEvent.change(search, { target: { value: 'zzz' } });
    const prevented = !fireEvent.keyDown(search, { key: 'Enter' });
    expect(prevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('starts over from the whole list the next time it is opened', () => {
    const { search } = openWithSearch();
    fireEvent.change(search, { target: { value: 'gcash' } });
    expect(screen.queryByText(/Revolving Fund/)).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByText('Select account'));
    expect(screen.getByText(/Revolving Fund Main Branch/)).toBeTruthy();
  });
});
