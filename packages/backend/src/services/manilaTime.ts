// The operating clock.
//
// Three clocks disagree on this deployment: the server runs Asia/Riyadh (UTC+3),
// the database session is Asia/Manila, and the client that types a date may be
// either. A naive `new Date('2026-10-06T09:00')` therefore resolves to Riyadh,
// `toISOString().slice(0, 10)` resolves to UTC, and the operator's own calendar
// day resolves to Manila — three different answers, which is why a shift could
// open on one day and record transactions on another.
//
// Every date the cash-management path reads or writes goes through this module,
// so the comparison the shift gate makes is always Manila against Manila.
// Instants are still stored as timestamptz in UTC (design §6); only the calendar
// day an operator names is Manila.

export const MANILA_TZ = 'Asia/Manila';

// The Philippines has no daylight saving, so the offset is a constant. That is
// what makes a naive wall-clock string recoverable without a tz database.
const MANILA_OFFSET = '+08:00';

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: MANILA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const dateTimeFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: MANILA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** The Manila calendar day an instant falls on, as `YYYY-MM-DD`. */
export function manilaDateKey(value: Date = new Date()): string {
  return dateFmt.format(value);
}

/** Manila wall clock for an instant, as `YYYY-MM-DDTHH:MM`. */
export function manilaDateTimeKey(value: Date = new Date()): string {
  const parts: Record<string, string> = {};
  for (const part of dateTimeFmt.formatToParts(value)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * Reads `YYYY-MM-DD` as a real calendar day, rejecting `2026-02-30` rather than
 * letting it roll into March — a shift dated 30 February is a mistyped date, not
 * the first of March's business.
 */
export function parseDateKey(value: string): Date | null {
  const match = DATE_KEY_RE.exec(String(value ?? '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00${MANILA_OFFSET}`);
}

/**
 * Turns a naive string an operator typed into the instant it names in Manila.
 *
 * Left alone if it already carries an offset, so a value that round-trips
 * through a `timestamptz` column is not shifted a second time.
 */
export function parseManilaDateTime(value: string): Date | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  // A bare day goes through the calendar check, so `2026-02-30` is refused
  // here rather than quietly rolling into March.
  if (DATE_KEY_RE.test(raw)) return parseDateKey(raw);
  const anchored = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}${MANILA_OFFSET}`;
  const parsed = new Date(anchored);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The `entry_date` bounds for a period an operator picked.
 *
 * The two ends are stated differently on purpose. The window *opens* at the
 * instant its first day begins, but it *closes* at the next Manila day, because
 * `end` names the last day **included**. Deriving the close from the instant
 * instead takes its UTC day — Oct 6 00:00 Manila is Oct 5 16:00 UTC — which
 * binds `entry_date < 2026-10-06` and cuts the final day out of every figure
 * while the report still prints the range it was asked for.
 *
 * Returned as one value so the ends cannot drift apart: one right and the other
 * built from an instant is exactly how they did.
 *
 * The upper bound's `::date + INTERVAL '1 day'` is read in the session's
 * timezone, which this deployment pins to Asia/Manila — the whole of the day
 * named, and none of the day after it.
 */
export function entryDateBounds(
  alias: string,
  startIndex: number,
  start: Date | null,
  end: Date | null,
): { conds: string[]; params: string[] } {
  const conds: string[] = [];
  const params: string[] = [];
  if (start) {
    conds.push(`${alias}.entry_date >= $${startIndex + params.length}`);
    params.push(start.toISOString());
  }
  if (end) {
    conds.push(`${alias}.entry_date < ($${startIndex + params.length}::date + INTERVAL '1 day')`);
    params.push(manilaDateKey(end));
  }
  return { conds, params };
}

/**
 * The date to compare a shift against: the one supplied, or now if the action
 * carries no date of its own.
 */
export function eventDateKey(value?: Date | string | null): string {
  if (typeof value === 'string') {
    const parsed = parseManilaDateTime(value);
    if (parsed) return manilaDateKey(parsed);
  } else if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return manilaDateKey(value);
  }
  return manilaDateKey();
}

/**
 * The day an operator picked, carrying the time it is being recorded at.
 *
 * Loading asks for a date only, but its row still wants an instant that sorts
 * correctly against the rest of the day. The previous version joined the picked
 * day to this host's clock, so a 14:00 entry in Manila was stamped 11:00.
 */
export function manilaDayAtCurrentTime(day: string): Date | null {
  if (!parseDateKey(day)) return null;
  return parseManilaDateTime(`${day}T${manilaDateTimeKey().slice(11)}`);
}
