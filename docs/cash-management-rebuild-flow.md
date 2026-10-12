# Cash Management Rebuild — Finalized Flow

Status: **for approval. No code until the owner approves this document.**
Source: the 2026-10-12 cash audit plus the owner's confirmed rules, quoted verbatim.

---

## 1. Principles

1. **Cash on Hand moves only when physical cash moves, by the exact amount.**
   No fee arithmetic on cash legs. The fee is a field on the transaction; the income report reads it.
2. **No unexplained movement.**
   Every posting names its source or destination. Transfers between the owner's own
   accounts always post both legs.
3. **The opening is a count, never a typed balance.**
   The drawer's balance is built only from ledger rows. The first row is the counted
   opening at cutover. Drift becomes structurally impossible.
4. **Business dates are real and immutable** — recorded when the event happened,
   never defaulted to midnight, never backdated.
5. **Reversals are first-class** — the only undo path, posting mirrored legs linked
   to the original (the established `REV-` rule, unchanged).

## 2. Accounts

| Account | Holds | Rule |
|---|---|---|
| **Cash on Hand (Drawer)** — one per branch | Physical cash | Moves only for physical cash, exact amounts |
| **Balances (channels)** — existing e-wallet + bank accounts | Electronic money | Never touched by pure cash events |
| **Legacy "Revolving Fund"** | History | Frozen at cutover, visible as Legacy, never posted to |
| **Income** | Fees + load margins | Read from transactions — **unchanged**, it already reconciles |

## 3. Confirmed posting rules (the owner's own words)

### Cash Out — "the customer pay me 30,300 including the 300 fee"
Cash received → e-money sent.
`drawer + (amount + fee)` · `channel/bank − amount` · fee = income.

### Cash In — "I will handle him a cash from my Cash on Hand"
E-money received → cash paid.
`drawer − (amount − fee)` · `channel + amount` · fee withheld from the payout = income.

### Loading — "Cost price will deducted to my balance. selling price will go to my cash on hand."
`drawer + selling price` · `channel − cost price` · margin = income (already reported).

### Funding and payments
- `owner_funding` via cash → `drawer + amount`. Via bank → `bank + amount`, **no drawer row**.
- `cash_payment` / `expense` / `operating_expense` paid from cash on hand → `drawer − amount`.
  Paid online → `bank − amount`, **no drawer row**.

## 4. Shift flow

**Open** — the staff counts the drawer → recorded as the opening count. Compared
against the ledger balance. Any difference requires a reason and an admin resolution
(the schema columns for this already exist, never wired: `opening_difference_reason`,
`opening_difference_notes`, resolution fields).

**During** — every event posts its exact-cash legs. The entry form shows a **leg
preview before saving** ("This will post: Cash on Hand −24,550 · Sheryll's e-wallet +24,800").

**Close** — expected closing = the ledger balance; the staff counts → counted closing;
variance explained (`variance_reason`); the balance carries to the next shift, whose
opening count must match this close.

## 5. Posting matrix — all types

### Confirmed

| Type | Cash | Drawer | Channel/Bank |
|---|---|---|---|
| `cash_out` — Cash received → e-money sent | enters | + amount + fee | − amount |
| `cash_in` — E-money received → cash paid | leaves | − (amount − fee) | + amount |
| Loading sale | enters | + selling price | − cost price |
| `owner_funding` (cash) | enters | + amount | — |
| `owner_funding` (bank) | none | — | + amount |
| `cash_payment` (cash on hand) | leaves | − amount | — |
| `cash_payment` (online) | none | — | − amount |
| `expense` (cash) | leaves | − amount | — |
| `operating_expense` (cash) | leaves | − amount | — |

### Proposed — one-nod confirmation needed

| Type | Cash | Drawer | Counter-leg |
|---|---|---|---|
| `bill_payment` — bills paid at the counter | enters | + amount + fee | channel − amount (paid to biller) |
| `customer_payment` | enters | + amount (+ fee) | as recorded |
| `customer_withdrawal` | leaves | − amount | customer wallet − amount |
| `loan_received` (cash) | enters | + amount | — |
| `loan_repayment` (cash) | leaves | − amount | — |
| `other_income` (cash) | enters | + amount | — |
| `owner_return` (cash) | leaves | − amount | — |
| `owner_return` (bank) | none | — | − amount |
| `refund` (cash to customer) | leaves | − amount | — |
| `refund_received` (cash) | enters | + amount | — |
| `service_fee` (collected cash) | enters | + amount | — |
| `transfer_fee` (collected cash) | enters | + amount | — |
| `transfer_in` (cash) | enters | + amount | — |
| `transfer_in` (account → account) | none | — | A +, B − |
| `transfer_out` (cash) | leaves | − amount | — |
| `transfer_out` (account → account) | none | — | A −, B + |
| `load_purchase` (paid cash) | leaves | − amount | channel + amount (credit received) |
| `load_purchase` (paid from channel) | none | — | channel A −, channel B + |
| `adjustment_in` / `adjustment_out` | depends | per the correction — reason + reference required | |

## 6. Entry form

- Type picker with a **cash-behavior badge**: "Cash leaves drawer" / "Cash enters drawer" / "No cash".
- **Leg preview** before posting — the exact rows that will be written.
- Business date shown, never defaulted to midnight.

## 7. Reports

- **Cash on hand** = the Drawer balance (must match a till count, to the centavo).
- **Shift** = expected vs counted, variance, reason.
- **Income** = unchanged (fees + load margins).
- **Non-cash accounts** = unchanged.
- **Legacy Revolving Fund** = frozen line.

## 8. Reversals — unchanged

Mirrored legs via the established `unwindDrawerLeg` rule; the drawer keeps the fee in
separate-fee mode; reversed fees are excluded from income; borrowings-outstanding
excludes reversed rows.

## 9. Cutover runbook

1. Choose the cutover moment (a shift open).
2. Stop all postings to the legacy Revolving Fund.
3. **Count the drawer** → post as the new Drawer's opening row.
4. Post **one documented adjustment** closing the legacy fund against the count —
   the unexplained difference becomes a single labeled line. The audit ends with a
   paper trail, not a mystery.
5. Point "Cash on hand" at the Drawer; verify `balance == counted cash`, to the centavo.
6. Loading posts its drawer leg from the first sale onward.

## 10. Relabeling

Keep every type **code** (history and reports stay intact). Change the **display
labels** to name both legs, e.g.:

- `cash_out` → "Cash received → E-money sent"
- `cash_in` → "E-money received → Cash paid out"

Plus the cash-behavior badge from §6.

## 11. Phases

| Phase | Work |
|---|---|
| 0 | This document — approval |
| 1 | Backend: drawer account, posting rules, shift wiring, leg preview |
| 2 | Loading cash leg (the + selling price) |
| 3 | Reports rewiring |
| 4 | Migration script + cutover |
| 5 | Frontend screens — after confirming how the SPA is served (today the backend serves only `/api` and `/uploads`) |

## 12. Open items

- Confirm the PROPOSED rows in §5 — one quick pass.
- Confirm how the SPA is served for Phase 5.
- Choose the cutover date/shift.
