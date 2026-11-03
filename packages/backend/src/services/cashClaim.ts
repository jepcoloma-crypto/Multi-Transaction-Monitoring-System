// Cash claim — who may confirm that physical cash arrived (design C2).
//
// Claiming is confirming receipt, not approving money: the duty operator who
// opened the branch's shift is exactly the person the cash was handed to, and
// administrators and managers cover the cases where they cannot be there. So
// the rule is a role check plus an identity check, and deliberately does NOT
// require `transactions.approve` — the two-person approval rule governs
// releasing a movement the branch chose to make, not stating that a customer
// paid.

export interface ClaimGateInput {
  roles: string[];
  userId: string;
  /** `shifts.opened_by` of the branch's currently open shift; null when none is open. */
  shiftOpenerId: string | null;
}

/**
 * Whether this user may settle an unclaimed cash-in.
 *
 * Pure on purpose: the route resolves the open shift (which it needs anyway
 * for the stamp and the D17 gate) and hands the opener's id in, so the whole
 * permission rule is one testable function with no database in the way.
 */
export function claimGate(input: ClaimGateInput): boolean {
  if (input.roles.includes('administrator') || input.roles.includes('manager')) return true;
  // Truthy, not just non-null: two empty strings compare equal, and a blank
  // opener must never match a blank caller.
  return Boolean(input.shiftOpenerId) && input.shiftOpenerId === input.userId;
}
