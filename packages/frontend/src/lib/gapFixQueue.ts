// Which accounts the Gap Fixes queue offers.
//
// The audit's `reconciled` is the integrity report's question: it also counts
// historical negative-balance rows, which cannot be un-written. An account
// carrying them — Revolving Fund holds 134 from one bad day, with gap 0 and a
// perfectly intact chain — is genuinely "not reconciled", but a gap fix has
// nothing to move on it: the server refuses such a proposal outright ("this
// account has no balance gap to fix"). Listing it anyway put a row on screen
// whose Propose button could never be pressed, under an "Open gaps" count that
// was not counting gaps.
//
// So the queue lists what its name says: an open balance gap. Accounts whose
// only defect is history stay visible on the integrity report, where the
// question is theirs to answer.

/** The one field the queue's rule reads — the audit account carries more. */
export const hasOpenGap = (account: { gap: number }): boolean => account.gap !== 0;
