import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ProductSelect from './ProductSelect';
import type { ProductOption } from './ProductSelect';

// The names this deployment actually runs, and the reason a plain list was
// not enough: "GO EXTRA 99" and "GO EXTRA 99 - MARIBANK" are both Globe, and
// three load products begin SMART POWER ALL / POWER ALL with different
// networks and prices. Prices arrive as strings — node-postgres hands numeric
// columns back as text and no type parser is installed.
const fromApi: ProductOption[] = [
  { id: 'p1', name: 'GLOBE GO EXTRA 199', provider_name: 'Globe', selling_price: '210.00', denomination: null },
  { id: 'p2', name: 'GLOBE GO EXTRA 99', provider_name: 'Globe', selling_price: '105.00', denomination: null },
  { id: 'p3', name: 'GO EXTRA 99 - MARIBANK', provider_name: 'Globe', selling_price: '105.00', denomination: null },
  { id: 'p4', name: 'POWER ALL 59 (MAYA)', provider_name: 'Smart', selling_price: '65.00', denomination: null },
  { id: 'p5', name: 'GIGA VIDEO 60', provider_name: 'TNT', selling_price: '65.00', denomination: '2.00' },
];

const renderPicker = (products: ProductOption[], value = '') => {
  const onChange = vi.fn();
  render(<ProductSelect products={products} value={value} onChange={onChange} placeholder="Select product" />);
  // Open the list so the option rows render.
  fireEvent.click(screen.getByText('Select product'));
  return { onChange };
};

describe('ProductSelect', () => {
  it('shows the provider and price beside a product whose price arrived as a string', () => {
    renderPicker(fromApi);
    const name = screen.getAllByText('GLOBE GO EXTRA 99').find((el) => el.tagName === 'STRONG')!;
    const row = name.closest('button')!;
    expect(row.textContent).toContain('Globe');
    expect(row.textContent).toContain('₱105.00');
  });

  it('reads a numeric price as readily as a string one', () => {
    renderPicker([{ id: 'p6', name: 'Test Load 50', provider_name: 'Globe', selling_price: 101 }]);
    expect(screen.getByText('₱101.00')).toBeTruthy();
  });

  it('shows no price for a product that has none, rather than inventing a zero', () => {
    renderPicker([{ id: 'p7', name: 'TestLoad', provider_name: 'GCash', selling_price: null }]);
    const row = screen.getByText('TestLoad').closest('button')!;
    expect(row.textContent).not.toContain('₱');
  });

  it('reports the chosen product by id', () => {
    const { onChange } = renderPicker(fromApi);
    fireEvent.click(screen.getByText(/GLOBE GO EXTRA 199/));
    expect(onChange).toHaveBeenCalledWith('p1');
  });
});

describe('ProductSelect search', () => {
  const openWithSearch = () => {
    const { onChange } = renderPicker(fromApi);
    const search = screen.getByLabelText('Search products') as HTMLInputElement;
    return { onChange, search };
  };

  it('takes focus when the panel opens, so typing narrows immediately', () => {
    const { search } = openWithSearch();
    expect(document.activeElement).toBe(search);
  });

  it('narrows to products whose name matches', () => {
    const { search } = openWithSearch();
    fireEvent.change(search, { target: { value: 'giga' } });
    expect(screen.getByText(/GIGA VIDEO 60/)).toBeTruthy();
    expect(screen.queryByText(/GLOBE GO EXTRA/)).toBeNull();
  });

  it('matches on the provider, which is what separates two same-priced Globe loads', () => {
    const { search } = openWithSearch();
    fireEvent.change(search, { target: { value: 'tnt' } });
    expect(screen.getByText(/GIGA VIDEO 60/)).toBeTruthy();
    expect(screen.queryByText(/GLOBE GO EXTRA 99/)).toBeNull();
  });

  it('narrows the near-identical names to the one asked for', () => {
    const { search } = openWithSearch();
    fireEvent.change(search, { target: { value: 'maribank' } });
    expect(screen.getByText(/GO EXTRA 99 - MARIBANK/)).toBeTruthy();
    expect(screen.queryByText(/GLOBE GO EXTRA 99/)).toBeNull();
  });

  it('matches on the price, for the operator who only remembers a number', () => {
    const { search } = openWithSearch();
    fireEvent.change(search, { target: { value: '210' } });
    expect(screen.getByText(/GLOBE GO EXTRA 199/)).toBeTruthy();
    expect(screen.queryByText(/GIGA VIDEO 60/)).toBeNull();
  });

  it('matches on the denomination', () => {
    const { search } = openWithSearch();
    fireEvent.change(search, { target: { value: '2.00' } });
    expect(screen.getByText(/GIGA VIDEO 60/)).toBeTruthy();
    expect(screen.queryByText(/GLOBE GO EXTRA 199/)).toBeNull();
  });

  it('says so rather than showing an empty panel when nothing matches', () => {
    const { search } = openWithSearch();
    fireEvent.change(search, { target: { value: 'nonexistent' } });
    expect(screen.getByText('No products match')).toBeTruthy();
  });

  it('picks the first match on Enter', () => {
    const { onChange, search } = openWithSearch();
    fireEvent.change(search, { target: { value: 'maribank' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('p3');
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
    fireEvent.change(search, { target: { value: 'tnt' } });
    expect(screen.queryByText(/GLOBE GO EXTRA/)).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByText('Select product'));
    expect(screen.getByText(/GLOBE GO EXTRA 199/)).toBeTruthy();
  });
});
