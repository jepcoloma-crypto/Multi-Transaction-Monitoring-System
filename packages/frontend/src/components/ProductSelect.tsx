import { formatCurrency } from '../lib/format';
import SearchableSelect from './SearchableSelect';

export interface ProductOption {
  id: string;
  name: string;
  provider_name?: string | null;
  /**
   * Arrives as a string, like every numeric column here: node-postgres hands
   * numerics back as text and no type parser is installed. Typed to accept
   * both so the shape the picker is handed need not be laundered first.
   */
  selling_price?: number | string | null;
  denomination?: number | string | null;
}

// The price is shown, so the price is searchable: an operator who half-remembers
// "the 105 one" should land on it. A missing price shows nothing rather than
// ₱0.00 — a product with no price on it is not being claimed to be free.
const priceOf = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function ProductLabel({ product }: { product: ProductOption }) {
  const price = priceOf(product.selling_price);
  return (
    <>
      <strong className="font-semibold">{product.name}</strong>
      {product.provider_name && (
        <> (<em className="italic">{product.provider_name}</em>)</>
      )}
      {price !== null && (
        <> - <em className="italic">{formatCurrency(price)}</em></>
      )}
    </>
  );
}

// Matching runs over everything the row shows. The names are close enough
// that the provider is often the only thing that separates them — "GO EXTRA
// 99" and "GO EXTRA 99 - MARIBANK" are both Globe — so both are searched,
// along with the price an operator may only remember as a number.
export const productMatches = (product: ProductOption, rawQuery: string): boolean => {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  return [product.name, product.provider_name, String(product.denomination ?? ''), String(product.selling_price ?? '')]
    .some((field) => (field ?? '').toLowerCase().includes(query));
};

interface ProductSelectProps {
  products: ProductOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  className?: string;
}

export default function ProductSelect({ products, value, onChange, placeholder, className }: ProductSelectProps) {
  return (
    <SearchableSelect
      items={products}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={className}
      matches={productMatches}
      renderOption={(product) => <ProductLabel product={product} />}
      searchLabel="Search products"
      emptyText="No products"
      noMatchText="No products match"
    />
  );
}
