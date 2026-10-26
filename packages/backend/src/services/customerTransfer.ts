// How a name typed onto a transaction becomes a registered customer.
//
// The Type Manually tab asks for one "Customer name" and one "Mobile number",
// and both land on the transaction row. `customers` instead wants a first and
// a last name, both required, so the single string has to be split somewhere —
// and the only honest rule available is that the last token is the surname.
//
// That is right for MARIA ROSARIO VALENCIA (given, middle, surname) and for
// REY PAWAL. It is transparent but ugly for the 36 of 82 in-scope names that
// end in an initial: DONNA B. becomes DONNA / B., and RAUL E. becomes RAUL /
// E. Recording the surname that was actually written down beats inventing a
// fuller one, and the review table shows every split for correction before
// anything is written.
//
// The halves must join back to the original string, because the registered
// customer view finds a name's unattached history by comparing
// `first_name || ' ' || last_name` against the transaction's customer_name
// (`routes/customers.ts`). So the join is exactly one space and the tokens are
// never edited — no case folding, no dropping of periods, no expanding of
// initials into anything they did not say.

export interface CustomerNameParts {
  firstName: string;
  lastName: string;
}

/**
 * Splits a typed name into the two columns `customers` requires.
 *
 * Last token is the surname; everything before it is the given name, which is
 * how the three-token Filipino names in the data read. A single token has no
 * surname to give — returning it as the first name and leaving the last empty
 * is deliberate, because the caller requires both and an empty surname has to
 * reach the operator's review rather than be guessed at.
 */
export function splitCustomerName(name: string): CustomerNameParts {
  const tokens = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { firstName: '', lastName: '' };
  if (tokens.length === 1) return { firstName: tokens[0], lastName: '' };
  return {
    firstName: tokens.slice(0, -1).join(' '),
    lastName: tokens[tokens.length - 1],
  };
}

/**
 * Rebuilds the string the two halves would be stored under.
 *
 * Used to compare a submitted pair against the name a transaction already
 * carries: when they agree, registering is really an attachment, and the
 * existing customer for that name must be linked rather than duplicated.
 */
export function rejoinCustomerName(parts: CustomerNameParts): string {
  return [String(parts.firstName ?? '').trim(), String(parts.lastName ?? '').trim()]
    .filter(Boolean)
    .join(' ');
}

/**
 * The contact numbers a name carries, newest first, without repeats.
 *
 * The query orders them by the transaction they came from, so the first entry
 * is the number on the most recent entry — the same number the column on the
 * tab shows. Nulls and blanks are dropped rather than becoming an empty option
 * in a list the operator has to read past.
 */
export function distinctContacts(contacts: unknown): string[] {
  if (!Array.isArray(contacts)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of contacts) {
    if (raw == null) continue;
    const value = String(raw).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
