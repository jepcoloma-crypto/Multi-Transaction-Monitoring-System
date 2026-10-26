import SearchableSelect from './SearchableSelect';

export interface CustomerOption {
  id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
}

// Matching runs over the number as well as the name. Two customers can share
// a name — the register action just created 75 of them from typed names — and
// the mobile number is often the only thing on the form that tells them
// apart, so an operator who half-remembers "Valdez on 0967" should land on
// the right one.
export const customerMatches = (customer: CustomerOption, rawQuery: string): boolean => {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  return [customer.last_name, customer.first_name, customer.phone]
    .some((field) => (field ?? '').toLowerCase().includes(query));
};

// Surname first, because that is how the list is scanned and how the tab
// already orders itself.
function CustomerLabel({ customer }: { customer: CustomerOption }) {
  return (
    <>
      <strong className="font-semibold">{customer.last_name}, {customer.first_name}</strong>
      {customer.phone && <span className="text-gray-400"> · {customer.phone}</span>}
    </>
  );
}

interface CustomerSelectProps {
  customers: CustomerOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  className?: string;
}

export default function CustomerSelect({ customers, value, onChange, placeholder, className }: CustomerSelectProps) {
  return (
    <SearchableSelect
      items={customers}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={className}
      matches={customerMatches}
      renderOption={(customer) => <CustomerLabel customer={customer} />}
      searchLabel="Search customers"
      emptyText="No customers yet"
      noMatchText="No customers match"
    />
  );
}
