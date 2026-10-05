export const formatCurrency = (amount: number): string => {
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return amount < 0 ? `-₱${formatted}` : `₱${formatted}`;
};

export const formatNumber = (n: number): string =>
  n.toLocaleString('en-PH', { maximumFractionDigits: 0 });

// Browser-local parts, not UTC: the backend parses these naive strings as
// Asia/Manila, so toISOString() would shift every entry by the UTC offset.
export const localDateValue = (d: Date = new Date()): string => {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const localDateTimeValue = (d: Date = new Date()): string => {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${localDateValue(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// transactions.payment_method is unconstrained VARCHAR(50), so nothing stops a
// new value reaching the detail view and every dropdown. One list here keeps
// the stored code and the text an operator reads in step.
export const paymentMethodOptions = [
  { value: 'cash', label: 'Cash' },
  { value: 'gcash', label: 'GCash' },
  { value: 'bank', label: 'Bank Transfer' },
  { value: 'maya', label: 'Maya' },
  { value: 'provider_interest', label: 'Interest Income from Provider' },
] as const;

// What a cash movement may be recorded as paid by. provider_interest is left
// out on purpose: it describes where an interest credit came from, not how cash
// changed hands, so offering it on a cash movement would let an operator record
// a method they could not have used. It stays available for the types where it
// makes sense.
export const movementPaymentMethodOptions = [
  { value: 'cash', label: 'Cash' },
  { value: 'gcash', label: 'GCash' },
  { value: 'bank', label: 'Bank Transfer' },
  { value: 'maya', label: 'Maya' },
] as const;

// The four movements where money can physically change hands. Listed here
// rather than derived from the server's list for the same reason the
// controlled movement codes are: adding a fifth has to touch both ends, and
// cannot quietly desynchronise the client's offer from the rule the server
// enforces.
export const cashMovementCodes = [
  'cash_in',
  'cash_out',
  'customer_payment',
  'customer_withdrawal',
] as const;

export const isCashMovementCode = (code: string | null | undefined): boolean =>
  (cashMovementCodes as readonly string[]).includes(String(code ?? ''));

export const paymentMethodLabel = (code: string | null | undefined): string => {
  if (!code) return '';
  return paymentMethodOptions.find((o) => o.value === code)?.label || code;
};
