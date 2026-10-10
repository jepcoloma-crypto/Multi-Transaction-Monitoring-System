// Expected cash at the close of a shift, and how a counted figure differs from
// it. Pure — no network, no database — so the arithmetic that decides whether a
// branch is short can be tested without one.
//
// A shift records what was counted, never a movement. The expected figure is
// arithmetic over movements that already exist, which is what keeps a
// discrepancy an event to investigate rather than a balance someone adjusted
// away (design D14). Reconciliation already uses this shape — expected, actual,
// variance, status — per account; this is the same at branch granularity.
//
// The expected figure is built from the shift's own counted opening float and
// not from the account's opening balance, so the two readings stay independent:
// if they are derived from each other they can never disagree, and a check that
// cannot disagree with itself is not a check (design D16).

const toCents = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

const money = (cents: number): number => cents / 100;

export type VarianceStatus = 'balanced' | 'over' | 'short';

export const VARIANCE_LABELS: Record<VarianceStatus, string> = {
  balanced: 'BALANCED',
  over: 'OVER',
  short: 'SHORT',
};

export interface ShiftMovement {
  entry_type: 'credit' | 'debit';
  amount: string | number;
}

function movementCents(movements: ShiftMovement[]): number {
  let cents = 0;
  for (const movement of movements) {
    cents += movement.entry_type === 'credit' ? toCents(movement.amount) : -toCents(movement.amount);
  }
  return cents;
}

/** Cash handed in less cash handed out, across the shift's window. */
export function netMovement(movements: ShiftMovement[]): number {
  return money(movementCents(movements));
}

/**
 * What the drawer should hold when the shift closes.
 *
 * A field the database left out or a row that is not a number contributes
 * nothing rather than turning the whole total into NaN: one unreadable figure
 * must not be able to make every branch's shift un-closeable.
 */
export function expectedClosing(
  openingFloat: string | number,
  movements: ShiftMovement[]
): number {
  return money(toCents(openingFloat) + movementCents(movements));
}

export interface VarianceReport {
  openingFloat: number;
  expected: number;
  counted: number;
  variance: number;
  status: VarianceStatus;
}

/**
 * Compare what was counted against what should have been there.
 *
 * The comparison is made in whole centavos so a column of fractions cannot
 * accumulate float error and report a shortage of a fraction of a centavo —
 * which would train an operator to ignore a badge that is always slightly red.
 */
export function classifyVariance(
  openingFloat: string | number,
  movements: ShiftMovement[],
  countedClosing: string | number
): VarianceReport {
  const expected = expectedClosing(openingFloat, movements);
  const counted = money(toCents(countedClosing));
  const variance = money(toCents(counted) - toCents(expected));

  return {
    openingFloat: money(toCents(openingFloat)),
    expected,
    counted,
    variance,
    status: variance === 0 ? 'balanced' : variance > 0 ? 'over' : 'short',
  };
}

/**
 * The second reading at close: what the drawer holds on the books against the
 * figure the count predicts.
 *
 * D16 requires the two readings to cross-check, and they can only do that if
 * both outlive the moment they were taken. `variance` has always been stored;
 * this one was computed and returned to the screen, then dropped, so after the
 * shift locked it could only be re-derived from a fund that has kept moving
 * since - a cross-check that exists while a response is on screen and nowhere
 * afterwards is not one anyone can audit.
 *
 * Because every movement posts its leg to the drawer as well as into the
 * expected figure, the movement cancels and the result reduces to the opening
 * float less the drawer's balance when the shift opened. It is therefore fixed
 * the moment the shift opens: no count at close can change it, and a non-zero
 * one means the float and the books disagreed from the start rather than that
 * the closing count was wrong.
 *
 * Both inputs are centavo-rounded before subtracting, as every other figure in
 * this file is. A balance read from a NUMERIC column and an arithmetic expected
 * figure can differ by a binary fraction, and a difference that must be exactly
 * zero to read as agreement cannot afford one.
 */
export function drawerDifference(expected: number, balance: number): number {
  return money(toCents(expected) - toCents(balance));
}

// The denominations a counter here actually handles, largest first so the tally
// reads the way cash comes out of a till. Values are held in centavos: a peso
// of 0.25 has no exact binary float, and subtotals that drift cannot be
// reconciled against a count that does not.
export const DENOMINATIONS: readonly { label: string; cents: number }[] = [
  { label: '1000', cents: 100_000 },
  { label: '500', cents: 50_000 },
  { label: '200', cents: 20_000 },
  { label: '100', cents: 10_000 },
  { label: '50', cents: 5_000 },
  { label: '20', cents: 2_000 },
  { label: '10', cents: 1_000 },
  { label: '5', cents: 500 },
  { label: '1', cents: 100 },
  { label: '0.25', cents: 25 },
];

const DENOMINATION_CENTS = new Map(DENOMINATIONS.map((d) => [d.label, d.cents]));

const pesos = (cents: number): string => money(cents).toFixed(2);

/**
 * Why a counted figure differs from the one the movements predict.
 *
 * A closed list rather than free text, because the answer is worth counting:
 * five shifts short under five different labels is a pattern, and free text
 * never aggregates. `other` is the escape hatch and is accepted only alongside
 * notes, so the catch-all still has to say something.
 */
export const VARIANCE_REASONS: Record<string, string> = {
  recount: 'Recounted - the first figure was wrong',
  missing_movement: 'A movement was never recorded',
  cash_paid_out: 'Cash left the drawer without a record',
  tender_outside: 'Change or tender handled outside the system',
  other: 'Something else, described in the notes',
};

/**
 * Enforced here rather than only in the route because this is the rule the
 * design rests on: a discrepancy that closes without a word is
 * indistinguishable from a discrepancy nobody investigated (D14). A balanced
 * shift owes no explanation and is never asked for one.
 *
 * Both checks below run through this one shape, because they are the same
 * question asked of the same person: a count that missed the expected figure
 * and a float that missed the drawer at open are two discrepancies, not two
 * vocabularies. A second list of reasons would mean the two could never be
 * counted together, and the answer worth having is the one that aggregates.
 */
function reasonError(
  difference: number,
  reason: unknown,
  notes: unknown,
  missing: string,
  notRecognised: string,
): string | null {
  if (toCents(difference) === 0) return null;

  const key = typeof reason === 'string' ? reason.trim() : '';
  if (!key) return missing;
  if (!Object.prototype.hasOwnProperty.call(VARIANCE_REASONS, key)) {
    return `"${key}" is not a recognised reason ${notRecognised}`;
  }
  if (key === 'other' && !String(notes ?? '').trim()) {
    return 'Choosing "something else" needs the notes to say what happened';
  }
  return null;
}

export function varianceReasonError(variance: number, reason: unknown, notes: unknown): string | null {
  return reasonError(
    variance,
    reason,
    notes,
    'A count that differs from the expected figure must say why it differs',
    'for a variance',
  );
}

/**
 * The same obligation at the other end of the shift.
 *
 * A float that differs from the drawer is fixed for the whole shift - the
 * movement posts to both sides and cancels, so no closing count clears it - and
 * a gap nobody explained when it was taken is a gap that cannot be explained
 * afterwards, because the person who counted has gone home and the drawer has
 * moved on. Asking at open is the only moment the answer is still available.
 *
 * Nothing here refuses the float. It is the count that was actually taken, and
 * D14 makes a discrepancy an event to investigate rather than an action to
 * block; what is required is that the event says why.
 */
export function openingReasonError(difference: number, reason: unknown, notes: unknown): string | null {
  return reasonError(
    difference,
    reason,
    notes,
    'A float that differs from the drawer on the books must say why it differs',
    'for an opening difference',
  );
}

/**
 * Which day a shift is allowed to claim.
 *
 * Three rules, one function, because they are one question asked about one
 * date and three copies of it would drift. Nothing here queries: `dayTaken` is
 * read by the caller first, so a day already recorded refuses her before a
 * float is typed rather than as a 409 after she has counted the drawer. What
 * makes it hold when two terminals reach for the same day at once is the
 * unique index on (branch_id, shift_date), not this — this is only the
 * sentence.
 *
 * One shift per branch per business day: a branch has one physical drawer, so
 * a second shift for the same day is a second count of the same money, and
 * the day's opening float would be summed twice by every report that ranges
 * over it.
 *
 * A past day is not refused, only made an administrator's call. Missing a day
 * is a real thing that happens and the record should still be made; what
 * should not happen is anybody quietly writing yesterday's date. Note that
 * only `opened_at` records when the count really took place, which is what
 * keeps an honest back-date traceable and an unhonest one visible.
 *
 * Order matters: a day already taken is the more useful thing to say, and an
 * administrator gets the same 409, so the message is never hiding a
 * permission behind a date.
 */
export function openShiftDateProblem(
  shiftDate: string,
  today: string,
  dayTaken: boolean,
  isAdmin: boolean,
): { status: 400 | 403 | 409; message: string } | null {
  if (shiftDate > today) {
    return { status: 400, message: `Shift date cannot be in the future — today is ${today}` };
  }
  if (dayTaken) {
    return { status: 409, message: `This branch already has a shift for ${shiftDate}` };
  }
  if (shiftDate < today && !isAdmin) {
    return {
      status: 403,
      message: `Only an administrator can open a shift for ${shiftDate} — that day has already passed`,
    };
  }
  return null;
}

/** What the denomination grid adds up to, in centavos. */
export function countDetailCents(detail: unknown): number {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return 0;
  let cents = 0;
  for (const [label, raw] of Object.entries(detail as Record<string, unknown>)) {
    const denomination = DENOMINATION_CENTS.get(label);
    if (denomination === undefined) continue;
    const quantity = Number(raw);
    if (!Number.isInteger(quantity) || quantity <= 0) continue;
    cents += denomination * quantity;
  }
  return cents;
}

/**
 * Check a breakdown against the total the shift is closing on.
 *
 * Null for a body that carries no breakdown at all: entering a total by hand
 * is still a legitimate count, and every shift recorded before this feature
 * exists has to keep closing. But once a breakdown is offered it must add up,
 * because two different answers for one drawer is precisely the disagreement
 * this module exists to surface rather than average away.
 */
export function countDetailError(detail: unknown, countedClosing: string | number): string | null {
  if (detail === null || detail === undefined) return null;
  if (typeof detail !== 'object' || Array.isArray(detail)) {
    return 'The denomination count must be quantities keyed by denomination';
  }

  const entries = Object.entries(detail as Record<string, unknown>);
  if (!entries.some(([, raw]) => Number(raw) > 0)) return null;

  for (const [label, raw] of entries) {
    if (!DENOMINATION_CENTS.has(label)) return `"${label}" is not a note or coin this counter tracks`;
    const quantity = Number(raw);
    if (!Number.isInteger(quantity) || quantity < 0) {
      return `The count of ${label} must be a whole number of notes or coins`;
    }
  }

  const entered = countDetailCents(detail);
  const declared = toCents(countedClosing);
  if (entered === declared) return null;

  return entered < declared
    ? `The denominations add to ${pesos(entered)}, which is ${pesos(declared - entered)} short of the ${pesos(declared)} declared`
    : `The denominations add to ${pesos(entered)}, which is ${pesos(entered - declared)} more than the ${pesos(declared)} declared`;
}

/**
 * The breakdown worth storing: only the quantities that were entered, keyed
 * the way the grid labels them. An empty grid stores nothing rather than a row
 * of zeros, so a hand-typed total leaves behind no claim that it was tallied.
 */
export function normalizeCountDetail(detail: unknown): Record<string, number> | null {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null;
  const stored: Record<string, number> = {};
  for (const [label, raw] of Object.entries(detail as Record<string, unknown>)) {
    const quantity = Number(raw);
    if (Number.isInteger(quantity) && quantity > 0 && DENOMINATION_CENTS.has(label)) {
      stored[label] = quantity;
    }
  }
  return Object.keys(stored).length > 0 ? stored : null;
}
