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

// Manila, not the browser's clock: the value typed here is parsed on the server
// as Manila, and the server, the database session and the operator's calendar
// have to name the same day. On a host running UTC+3 the two disagree for eight
// hours every night — the day an entry defaults to would be the day *before*
// the shift the operator just opened.
//
// Intl with an explicit zone rather than `d.getDate()`, because the browser's
// zone is not the market's.
const MANILA_TZ = 'Asia/Manila';

const manilaDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: MANILA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const manilaDateTimeFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: MANILA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const partsOf = (formatter: Intl.DateTimeFormat, d: Date): Record<string, string> => {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(d)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
};

export const manilaDateValue = (d: Date = new Date()): string => {
  const p = partsOf(manilaDateFmt, d);
  return `${p.year}-${p.month}-${p.day}`;
};

export const manilaDateTimeValue = (d: Date = new Date()): string => {
  const p = partsOf(manilaDateTimeFmt, d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};

/**
 * A `shift_date` is already a Manila calendar day, so this is label-making only
 * and no zone arithmetic is involved: the day is read as UTC midnight and
 * printed in UTC, which reproduces the same day in any browser.
 */
export const dateKeyLabel = (key: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  const date = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return key;
  return date.toLocaleDateString('en-PH', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
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
