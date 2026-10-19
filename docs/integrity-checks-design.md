# Integrity Checks — an auditor's read-only view of whether the books agree

## 1. Why this exists

On 2026-10-19 two cash-ins (transactions 3 and 21) put a ₱10 service fee in the wrong
pocket: the receiving e-wallet was credited a fee it had just paid, and the till handed
over the whole amount instead of keeping the fee. Twenty pesos sat in Vanessa Bautista's
wallet that belonged to the drawer.

Every internal invariant held. D24's identity (`signed + drawer_delta = fee`) held on both
rows, every test passed, no balance failed to reconcile against its own ledger. The defect
was not arithmetic — it was **placement**, and placement is invisible to any check that
looks at one surface.

The ₱20 was found only because two *different subsystems* were compared by hand:

- the income report reads `transactions.fee` where `fee_added_to_balance IS NOT FALSE`
  (`routes/cashManagement.ts`, `drawerIncome = fee_on_top + load_margin`) and claims the
  till earned **₱575**;
- the drawer's ledger rows carried **₱555**.

Both statements were internally correct. Neither could see the other. Nothing in the system
ever asked whether they agreed.

A second gap sat beside it. The `auditor` role holds seven read permissions — accounts,
audit_logs, loading, reconciliation, reports, transactions, transfers — but not
`transactions.correct`, and the Fee Audit page requires that. The person whose job is
auditing could not reach the one page that inspects fees.

## 2. The design decisions

### IC1 — the check compares surfaces that do not derive from each other

A check cannot catch a rule that is wrong but self-consistent, and D42's was. Every
invariant the posting path asserts was satisfied by the faulty rows. So the checks that
matter are the ones that put a **business claim** beside a **physical fact** and ask if they
agree — the income report's claim about what the till earned, versus what the till's rows
actually carry.

Per-movement checks (D24's identity, `net_amount` against a recomputed posting) are retained
only where they catch genuinely different failure modes, not because they would have caught
this one. They would not have.

### IC2 — a finding is a disagreement, not a diagnosis

The audit says two numbers differ. It does not, and cannot, say which one is wrong. Today's
finding would have read "income says ₱575, the till carries ₱555" — and correcting it
required **D46**, a policy decision about who the fee belongs to.

So the checks **never write, and never guess**. Where a known correction path applies, the
finding links to it — the existing Fee re-post, the amount correction, the re-entry —
pre-filled with the figures, and the administrator confirms, types the reason and sees the
planned rows before anything is appended. Where no correction path can be justified, the
finding says *investigate* and offers nothing. That refusal is the feature: a tool that
guessed would have moved the ₱20 the wrong way with identical-looking output, which is the
same class of error as the one being corrected.

### IC3 — the auditor sees, the administrator acts

The page is gated on `reconciliation.read`, which the auditor and administrator roles both
already hold, so **no permission and no role is added**. There is no write path in the
module at all. Separation of duties is structural rather than a rule somebody has to
remember: the role that can see every finding cannot move a peso, and the tools that can
move a peso are unchanged and still administrator-gated.

### IC4 — the drawer is resolved by type, and per branch

The till is the account of type `Cash`. Production holds two accounts of that type, both
named "Revolving Fund", so the drawer cannot be resolved by name or globally. It is resolved
from `account_types`, and each movement's drawer is the cash account its own rows name —
never an assumed one. A movement booked straight onto the drawer writes no counterparty row
and is read that way rather than treated as missing.

### IC5 — fee rows are marked by description, and that is a known weakness

`ledger_entries` has no column saying which leg a row is; the codebase documents this, and
the statement reads the same marker. The checks therefore reuse `isFeeLedgerRow`'s prefix
(`Service fee`) so that a check and a statement can never disagree, and additionally count
`Fee correction:` rows — because after a re-post the fee arrives as a correction line, not a
fee line, and counting only the latter would report a permanent false gap for exactly the
rows that were corrected.

String-matching a durable financial fact is the weakest part of this design. It is accepted
for now because it matches the marker the rest of the system already trusts.

**Deferred:** a migration adding `role` to `ledger_entries` (`fee` / `movement` /
`correction`), turning the marker into a fact. Deliberately not bundled here — this module
carries no migration.

### IC6 — the checks start from the records, never from the rows

A query that starts from `ledger_entries` will simply not return a movement that has no
drawer rows, and such a movement would pass by omission. Every check therefore starts from
`transactions` and left-joins to the ledger, so a missing row is a finding rather than an
absence.

## 3. The three checks

Each is a pure function over plain data, in `services/integrityChecks.ts`, testable without
HTTP or a database — the same shape as `classifyFeeMovement`. `routes/integrity.ts` gathers
the rows and hands them over; it writes nothing.

### Check 1 — the till holds what income says it earned

For every completed movement whose fee the income report books as till income
(`fee_added_to_balance IS NOT FALSE`), the drawer must carry that fee.

    income claim  = Σ t.fee     where completed and fee_added_to_balance IS NOT FALSE
    till carries  = Σ the drawer's fee-bearing rows for those same movements

Validated against production: **₱575.00 against ₱575.00, 31 movements, no findings.** Before
the correction it read **₱575 against ₱555** and named transactions 3 and 21 — which is the
proof this check is the one that matters.

### Check 2 — the fee's row sits where its mode says

    cash-in,  fee inside   the receiving account carries the fee row
    cash-in,  fee on top   the drawer carries the fee row
    cash-out, either mode  the drawer carries the fee row

Validated: 8 of 8 fee-inside cash-ins on the account, 2 of 2 fee-on-top cash-ins in the
drawer, 29 of 29 cash-outs in the drawer.

This is the check that closes the blind spot D46 left open. `classifyFeeMovement` judges a
movement by its account total and its till net, and since both cash-in cells move the same
figures, a backwards fee flag reads `ok`. Row placement does not share that blindness: the
two cells put the fee's own row on opposite sides, so the flag is checkable from the ledger
even though the pesos are identical.

### Check 3 — `net_amount` is what the account's rows sum to

`net_amount` is stored as a **magnitude**; a debit's rows sum to a negative number. The
predicate is therefore against the absolute value, and this was found by running the check
before trusting it — the unsigned form reported 30 findings on perfectly correct books.

    net_amount  =  |Σ the primary account's own ledger rows|

Validated: 41 of 41 transactions pass. **This check did not catch today's defect**, and the
design says so plainly: a cash-in posted backwards has a `net_amount` matching the rows it
wrote, because both were produced by the same superseded rule. What it catches is the
failure mode where the column and the rows were later driven apart — an amount correction
that moved the record without moving the ledger, or rows rewritten under a rule the record
no longer reflects. The ₱20 was caught by checks 1 and 2, not by this one.

## 4. What this module does not do

- **No writes of any kind.** No correction, no balance update, no schema migration, no
  permission change.
- **No auto-fix**, at any level (IC2).
- **No alert thresholds or detector logic** are touched.
- **No new checks beyond the three.** Balance recomputation and orphan detection were
  considered and deferred; D24's identity was considered and dropped as the load-bearing
  check, because it held throughout the incident.

## 5. Running it

On demand, from the Integrity page, gated on `reconciliation.read`. There is no schedule and
no trigger: the queries are read-only and bounded, so an auditor can run them mid-shift
without affecting trading. A finding carries the figures, the movement, and the link to the
correction tool where one applies.
