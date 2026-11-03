# Cash claim — unclaimed cash-ins

**Status:** design approved pending implementation sign-off
**Decisions confirmed:** 2026-10-31

## The problem

A cash-in is created `completed` the moment it is typed: for every type outside
the controlled list, `movementPlan.ts` computes
`finalStatus = requiresApproval ? 'pending' : 'completed'`, and the plan
explicitly refuses to let ordinary types wait at all
(`movementPlan.ts:263`). So the books state **"money is in the drawer"**
before the customer has necessarily handed anything over.

When the customer walks out without paying, the record is a lie the moment it
exists: the drawer's expected count, the income report and every integrity
check now claim cash the till does not hold. The only tool today is the
reversal flow — an admin-approved cancellation with a re-entry — which is far
too heavy for "the customer has not paid yet".

## Confirmed decisions

| # | Decision |
|---|---|
| C1 | **Two-phase cash-in.** Record now, *claim* when the physical cash arrives. An unclaimed row posts no ledger legs. |
| C2 | **Who may claim:** the duty operator — the opener of that branch's currently open shift (`shifts.opened_by`) — plus administrators and managers. Claiming confirms receipt; it is not an approval and does not require `transactions.approve` or a second signature. |
| C3 | **Every transaction links to its shift.** `shift_id` is stamped at creation from the branch's open shift, so each cash row permanently belongs to a duty operator's shift. The claim itself stamps `claimed_by` / `claimed_at` (recorder and receiver may differ). |
| C4 | **Never auto-reject.** Unclaimed rows age in a visible queue; staff or an admin rejects them when it is clear the customer never paid. No scheduler, no detector. |
| C5 | **"Unclaim" after completion is never a flag-flip.** If a completed row turns out to be unpaid, the books have posted money that does not exist — the only correct undo is the existing reversal flow. The UI offers it as a pre-filled shortcut, not as new money logic. |
| C6 | **v1 covers `payment_method = 'cash'` only.** E-wallet/bank/maya rows complete as they do today. The cash-out mirror (customer never *collected*) is a later, separate feature. |

**Explicitly out of scope:** expense thresholds, `controlledApproval` rules for
every other type, detector/integrity logic, the ATM fee rule, the approval
two-person rule. Claim reuses the existing posting path, so no new money math
is introduced anywhere.

## State model

```
cash-in, cash method, "cash not yet received" chosen at entry
   │
   ▼
pending · pending_reason = 'cash_receipt'        UNCLAIMED
   │   - no ledger legs, no drawer, no income          (editable, rejectable)
   │
   │  customer hands the money to the duty operator
   ▼
POST /transactions/:id/claim
   │   - stamps claimed_by / claimed_at
   ▼
completed · ledger posts (same legs an immediate completion would have written)

customer never pays ──► admin rejects the pending row (existing route)
books already completed and cash never arrived ──► C5: reversal shortcut
```

Ordinary "cash received now" entries (the default) keep their current
behaviour: created `completed`, posted at once.

## Data model — migration `051_cash_claim.sql`

```sql
ALTER TABLE transactions
  ADD COLUMN shift_id         uuid REFERENCES shifts(id) ON DELETE SET NULL,
  ADD COLUMN pending_reason   varchar(20),
  ADD COLUMN claimed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN claimed_at       timestamptz;

ALTER TABLE transactions ADD CONSTRAINT valid_pending_reason
  CHECK (pending_reason IS NULL OR pending_reason IN ('approval', 'cash_receipt'));

CREATE INDEX idx_transactions_shift ON transactions(shift_id);
CREATE INDEX idx_transactions_unclaimed
  ON transactions(branch_id_or_account, created_at) WHERE status = 'pending' AND pending_reason = 'cash_receipt';
-- exact index expression finalized during implementation (transactions carry
-- no branch_id; scoping goes through account_id, see below)

-- Existing pending rows were all waiting on approval:
UPDATE transactions SET pending_reason = 'approval' WHERE status = 'pending';
```

Notes:

- `status` needs **no** CHECK change — `pending` and `completed` already exist.
- `transactions` has no `branch_id`; the branch comes from `account_id`
  (that is what `assertBranch` and the shift lookups already use). Likewise
  `shift_id` is resolved from the account's branch, exactly as
  `shiftGate.ts` resolves the open shift today (D17 already requires one at
  creation for every movement except owner funding, so the stamp is available
  for free — owner-fund rows simply keep `shift_id = null`).

## Backend rules

### Creation (narrow exception to `movementPlan.ts:263`)

An ordinary (non-controlled) type may be created `pending` when **all** of:

- `payment_method = 'cash'` (physical tender),
- `direction = 'in'` (cash-in only, per C6),
- the operator explicitly asked for it (`cashReceived: false` on the request —
  the form's "Cash not yet received" choice),

and then `pending_reason = 'cash_receipt'` is set on the row. Everything else
— controlled types, e-wallet methods, cash-outs — behaves exactly as today.
Provider charges stay refused on non-completed rows (existing rule).

### `POST /transactions/:id/claim`

Authorization — **not** `transactions.approve`; the check is, in order:

1. `assertBranch(account_id, 'transactions.write')` — branch scope first, so
   the route cannot probe rows outside the caller's branches (same pattern as
   approve),
2. caller is `administrator` or `manager`, **or** caller is the
   `shifts.opened_by` of that branch's *currently open* shift (C2),
3. row guards: `status = 'pending'`, `pending_reason = 'cash_receipt'`
   (approve's controlled-type, own-request and head-office gates do **not**
   apply — they are approval semantics, and here the duty operator may well be
   the recorder, by design),
4. `assertOpenShift(account_id, code, { eventDate: row.transaction_date })` —
   the same D17 gate settle already uses. A claim dated after the shift moved
   on is refused with the same remedy late approvals get (an administrator may
   open a shift for that date retroactively).

Settlement posts the legs through a **shared function extracted from the
approve route** (one rule, one place — approve and claim must not drift apart
on fee rows, drawer legs or lock order), then stamps `claimed_by`,
`claimed_at`, flips `status = 'completed'`, and writes audit
`transaction.claimed`.

Double-claim and races: `SELECT … FOR UPDATE OF t` plus the status guard
inside the same transaction — identical to approve.

### Existing routes that already do the right thing

- **Reject** works on any pending row and is deliberately ungated by the shift
  gate — an admin can clear an unpaid row at any time.
- **Edit** already allows editing pending rows (`transactions.ts:1061`).
- **Reversal** (C5) is the only undo for a completed-but-unpaid row; no new
  backend surface — the UI just pre-fills its reason.

## Frontend

1. **Entry form** — for cash + direction in, a two-way choice:
   *Cash received now* (default, completes as today) / *Not received yet —
   record as unclaimed*.
2. **Pending list** — `Unclaimed` badge + filter, and `unclaimedCount`
   beside `pendingCount` in the list summary
   (`transactions.ts:204`), sorted oldest-first so aging rows surface.
3. **Claim button** — shown per C2 (duty operator, admin, manager); disabled
   with a tooltip naming the rule for anyone else.
4. **Receipt** — a pending `cash_receipt` row prints
   *"UNCLAIMED — cash not yet received; no money has entered the till."*
   instead of the awaiting-approval sentence; the approval sentence is kept
   for `pending_reason = 'approval'`. The bottom **Total** row is unaffected —
   it is the price, not a balance claim.
5. **Detail drawer** — shows the duty operator (via `shift_id` →
   `shifts.opened_by`) and, once claimed, who received the cash and when.
6. **Unclaim shortcut** on completed rows opens the existing reversal request
   pre-filled with "Cash never received" (C5).

## Edge cases

| Case | Behaviour |
|---|---|
| No open shift at creation | Already refused by D17 (except owner funding, which keeps `shift_id = null`) |
| Shift closed while a row sits unclaimed | Claim refused (409) until a shift covering the row's date is open — same as a late approval |
| Customer pays across midnight | Handled by the same `eventDate` rule as approval; admin opens the missed day if needed |
| Two people tap Claim | Second one loses: `FOR UPDATE` + status guard |
| Rejected instead of claimed | No legs were ever posted — nothing to undo |
| E-wallet / bank / maya rows | Never unclaimed (C6) |
| Unclaimed row in a shift's expected count | Invisible by construction — no legs posted, so drawer, income and integrity checks stay truthful while waiting |

## Test plan

**Backend (node:test, baseline 666):**
creation with `cashReceived:false` posts no legs (balances byte-identical
before/after) while `completed` creation does; claim posts exactly what
immediate completion would have (the identity checks must still pass);
permission matrix (duty operator ✅, other operator ❌, admin ✅, manager ✅,
wrong branch ❌); claim without open shift → 409; double claim → 400;
reject of an unclaimed row succeeds; e-wallet + cash-out + provider-charge
requests for unclaimed are refused; `shift_id` stamped at creation;
audit entries written.

**Frontend (vitest, baseline 160):**
form choice toggle and payload; badge/filter/count; claim button visibility
per role; receipt note text for both pending reasons.

**Regression:** integrity checks and shift expected-count tests unchanged —
the feature's whole point is that they never fire for this cause.

## Rollout

1. Branch `feat/cash-claim`; migration `051`; `npm run migrate`.
2. Backend + frontend tests green, `npm run build:backend` +
   `npm run build:frontend`.
3. Deploy only with explicit approval (`pm2 startOrReload ecosystem.config.js
   --update-env` for the migration + restart; Vercel push for the frontend).
4. Live check: create an unclaimed cash-in, confirm the drawer/income figures
   did not move, claim it, confirm they did.
