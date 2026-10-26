import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CustomerSelect from './CustomerSelect';
import type { CustomerOption } from './CustomerSelect';

// The shape /customers answers with: the register action created most of
// these from names typed onto transactions, so a surname can be an initial
// and a customer can have no number at all.
const fromApi: CustomerOption[] = [
  { id: 'c1', first_name: 'MARIA ROSARIO', last_name: 'VALENCIA', phone: '09754778618' },
  { id: 'c2', first_name: 'DARYL MAE', last_name: 'VALDEZ', phone: '09171009014' },
  { id: 'c3', first_name: 'DONNA', last_name: 'B.', phone: null },
];

const renderPicker = (customers: CustomerOption[], value = '') => {
  const onChange = vi.fn();
  render(<CustomerSelect customers={customers} value={value} onChange={onChange} placeholder="Select a customer" />);
  fireEvent.click(screen.getByText('Select a customer'));
  return { onChange };
};

describe('CustomerSelect', () => {
  it('shows the surname first, with the number beside it', () => {
    renderPicker(fromApi);
    expect(screen.getByText('VALENCIA, MARIA ROSARIO')).toBeTruthy();
    expect(screen.getByText('· 09754778618')).toBeTruthy();
  });

  it('shows a customer with no number on file rather than hiding them', () => {
    renderPicker(fromApi);
    expect(screen.getByText('B., DONNA')).toBeTruthy();
    // No stray separator left behind where the number would have been.
    expect(screen.getByText('B., DONNA').closest('button')!.textContent).not.toContain('·');
  });

  it('reports the chosen customer by id', () => {
    const { onChange } = renderPicker(fromApi);
    fireEvent.click(screen.getByText(/VALDEZ/));
    expect(onChange).toHaveBeenCalledWith('c2');
  });
});

describe('CustomerSelect search', () => {
  const openWithSearch = (customers = fromApi) => {
    const { onChange } = renderPicker(customers);
    return { onChange, search: screen.getByLabelText('Search customers') as HTMLInputElement };
  };

  it('narrows on the surname', () => {
    const { search } = openWithSearch();
    fireEvent.change(search, { target: { value: 'valde' } });
    expect(screen.getByText(/VALDEZ/)).toBeTruthy();
    expect(screen.queryByText(/VALENCIA/)).toBeNull();
  });

  it('narrows on the given name, including one carrying a middle name', () => {
    const { search } = openWithSearch();
    fireEvent.change(search, { target: { value: 'rosario' } });
    expect(screen.getByText(/VALENCIA/)).toBeTruthy();
    expect(screen.queryByText(/VALDEZ/)).toBeNull();
  });

  it('matches on the mobile number, which is often all that is remembered', () => {
    const { search } = openWithSearch();
    fireEvent.change(search, { target: { value: '0917' } });
    expect(screen.getByText(/VALDEZ/)).toBeTruthy();
    expect(screen.queryByText(/VALENCIA/)).toBeNull();
  });

  it('separates two customers who share a name by their number', () => {
    const sameName: CustomerOption[] = [
      { id: 's1', first_name: 'JOY ANTHONY', last_name: 'V.', phone: '09360956245' },
      { id: 's2', first_name: 'JOY ANTHONY', last_name: 'V.', phone: '09813155479' },
    ];
    const { onChange, search } = openWithSearch(sameName);
    fireEvent.change(search, { target: { value: '0981' } });
    expect(screen.getByText(/09813155479/)).toBeTruthy();
    expect(screen.queryByText(/09360956245/)).toBeNull();
    fireEvent.click(screen.getByText(/09813155479/));
    expect(onChange).toHaveBeenCalledWith('s2');
  });

  it('says so rather than showing an empty panel when nothing matches', () => {
    const { search } = openWithSearch();
    fireEvent.change(search, { target: { value: 'nobody-here' } });
    expect(screen.getByText('No customers match')).toBeTruthy();
  });

  it('says so when there are no customers at all', () => {
    renderPicker([]);
    expect(screen.getByText('No customers yet')).toBeTruthy();
  });
});
