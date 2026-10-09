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

const manilaFullFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: MANILA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
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
 * The inverse of `manilaDateTimeValue`. A wall-clock minute read off a
 * `datetime-local` input is turned back into the UTC instant it names, which is
 * what the database stores and what must be sent back when a date is corrected.
 *
 * The clock is read as if it were UTC, then stepped back by the offset the zone
 * carried at that instant. Manila is a fixed UTC+8 with no daylight saving, so
 * one step is exact — but the offset is read from the zone rather than assumed,
 * so the pairing stays correct if that ever changes.
 */
export const manilaInputToIso = (value: string): string | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [, year, month, day, hour, minute] = m.map(Number);

  const readAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const seen = partsOf(manilaFullFmt, new Date(readAsUtc));
  const seenAsUtc = Date.UTC(
    Number(seen.year),
    Number(seen.month) - 1,
    Number(seen.day),
    Number(seen.hour),
    Number(seen.minute),
    Number(seen.second)
  );

  const iso = new Date(readAsUtc - (seenAsUtc - readAsUtc)).toISOString();
  // A value the zone cannot represent would round-trip to a different clock
  // than the one typed, so it is refused rather than silently shifted.
  return manilaDateTimeValue(new Date(iso)) === value ? iso : null;
};

/**
 * A `shift_date` is already a Manila calendar day, so this is label-making only
 * and no zone arithmetic is involved: the day is read as UTC midnight and
 * printed in UTC, which reproduces the same day in any browser.
 */
export const dateKeyLabel = (
  key: string,
  options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' },
): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  const date = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return key;
  return date.toLocaleDateString('en-PH', {
    timeZone: 'UTC',
    ...options,
  });
};

const manilaTimeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: MANILA_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Manila wall-clock time for a stored instant.
 *
 * `entry_date` is `TIMESTAMPTZ`, so UTC is what reaches the browser and the
 * browser's own zone decides what it says — on this UTC+3 host a 23:30 entry
 * prints as 02:30 the next morning. Every row inside a shift's window belongs
 * to that one shift day, so the hour is the only part worth showing anyway.
 */
export const manilaTimeLabel = (value: string | Date | null | undefined): string => {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) return '—';
  return manilaTimeFmt.format(date);
};

const manilaDayFmt = new Intl.DateTimeFormat('en-PH', { timeZone: MANILA_TZ });

/**
 * Manila calendar day for a stored instant — the counterpart to
 * `manilaTimeLabel`, and the fix for the `entry_date` rows.
 *
 * `TIMESTAMPTZ` reaches the browser as UTC and the browser's own zone decides
 * what day that is. On this UTC+3 host an entry made at 00:30 in Manila prints
 * as the day *before*. Inside a period statement that is not cosmetic: the row
 * would appear under a date outside the From/To range printed above it, and a
 * page filed with the wrong day is wrong whether or not the arithmetic is.
 */
export const manilaDayLabel = (value: string | Date | null | undefined): string => {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) return '—';
  return manilaDayFmt.format(date);
};

const manilaDateTimeSecFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: MANILA_TZ,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * Manila date *and* time for a stored instant — what `toLocaleString()` on a
 * row used to print, minus the browser's zone.
 *
 * The seconds stay because the rows that use it are audit and approval
 * records: two decisions in the same minute would otherwise be told apart by
 * nothing the reader can see.
 */
export const manilaDateTimeLabel = (value: string | Date | null | undefined): string => {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) return '—';
  return manilaDateTimeSecFmt.format(date);
};

const manilaClockSecFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: MANILA_TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * Manila wall-clock for a timestamp taken now rather than stored: the
 * dashboard's "last refreshed", which ticks. The seconds are the point, so
 * this corrects the zone and leaves the rest of the face alone.
 */
export const manilaClockLabel = (value: string | Date = new Date()): string => {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) return '—';
  return manilaClockSecFmt.format(date);
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

/**
 * The method as a record displays it, naming an absence instead of hiding it.
 *
 * `paymentMethodLabel` stays blank on null because Accounts builds a sentence
 * out of it — "Owner funding via GCash" must not become "Owner funding via"
 * when a form field is empty. Here the absence *is* the information: 108
 * historical cash movements predate the rule that made the column mandatory
 * and were deliberately left unclassified rather than guessed at (D11), so an
 * empty cell reads as a rendering bug where "Not recorded" reads as a fact.
 */
export const paymentMethodCell = (code: string | null | undefined): string =>
  paymentMethodLabel(code) || 'Not recorded';

/**
 * The note printed under the Cash on hand figure: which accounts it totals.
 *
 * The drawer is one number under two names — the account holding the cash and
 * the line totalling it — so a reader who does not know that sees two pots
 * holding the same peso and asks which of them is real. Naming the accounts
 * says it outright.
 *
 * Falls back to the bare note rather than to a partial one: a label that
 * explains nothing is better than one that names the wrong account, and the
 * server is the only place that knows which accounts are cash.
 */
export const cashOnHandNote = (accountNames?: string | null): string => {
  const names = String(accountNames ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name, index, all) => all.indexOf(name) === index);
  return names.length > 0
    ? `${names.join(', ')} — in the branch drawers, already counted in the total`
    : 'In the branch drawers — already counted in the total';
};
