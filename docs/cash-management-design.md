# Cash Management Module — Design

Status: **Phases A–E implemented and deployed** (migrations 034/035 applied to production,
engine, endpoints, Cash Management page, Expense report component — commits `b3d8faf`,
`3a5005e`, `8a0f176`).

Sections 10 onward — drawer participation, shifts, the open-shift precondition of §18 and the
live/period split of §19 — are **pushed and running in production**: `git log origin/main..HEAD`
is empty, and migrations 036–039 are applied (036/037 on 6 Oct 2026, 038/039 in the same
week). The order below is kept as the record of *why* it was forced, not as work outstanding:

1. **Fund the revolving funds first**, using the code as it runs today. F3 gives the drawer
   a ledger leg, and a leg that cannot be paid is refused: with both drawers at ₱0 every
   cash movement reaching them would fail the moment it is deployed. Owner funding does not
   need this code — it posts straight to the cash account.
2. **Apply migrations 036 and 037** before the backend that reads them goes live, or the
   shift screen finds no `shifts` table. It reports that gracefully, but it is a wasted
   deployment.
3. **Frontend before backend.** The New Transaction form only gained the payment-method
   field in `fbfe733`; the running backend does not require one. Reverse that order and
   every cash-in and cash-out is refused with *"needs a payment method"* until the frontend
   follows — this is the one ordering that breaks production rather than degrading it.
4. **§18's gate last**, and only once operators can open a shift: on the day it lands every
   branch is blocked until someone opens one (end of §18).

**How production loads backend code.** `ecosystem.config.js` runs
`packages/backend/dist/index.js` with `watch: false`, so production serves a *build* —
editing `packages/backend/src` changes nothing until someone runs `npm run build` and
restarts PM2. That was not always true: it previously ran ts-node straight on the working
tree, so every memory restart shipped whatever was mid-edit, and unshipped source sat live
during the first build of this piece. Nothing failed only because no cash movement had been
attempted since — luck, not safety. Two consequences now hold:

- **`npm run build` is the deploy step.** Treat it as production-facing.
- **Tests never write to `dist`.** They compile to `packages/backend/dist-test`
  (`tsconfig.test.json`), so running the suite cannot overwrite what PM2 serves.

Scope: model the company's funds flow — sources, uses, revolving-fund reconciliation and
per-branch cash position — and add the one flow the system cannot record today: operating
expenses paid from actual cash on hand.

---

## 1. Verified current state

Everything below was checked against the live database and source before writing this.

### Accounts

15 accounts, two branches, all company-owned wallets (confirmed with the business owner —
these are **not** customer balances, so debiting them for company expenses is correct).

| Type | Count | Balance |
|---|---:|---:|
| `bank` | 3 | ₱80,647.00 |
| `e-wallet` | 12 | ₱41,725.00 |
| **`cash`** | **0** | **—** |

`account_types` already defines a `cash` type. **Nothing uses it.** There is no account in
the system that represents physical cash on hand, and no mention anywhere of a revolving
fund, petty cash or imprest.

`accounts.owner` and `accounts.purpose` exist as columns and are **empty on every row** —
they were built for exactly this labelling and have never been filled in.

### The identity already holds

```
   121,391.00   Σ accounts.opening_balance
 + 272,360.00   Σ ledger credits
 − 271,379.00   Σ ledger debits
 ─────────────
 = 122,372.00   Σ accounts.current_balance   ✓ exact
```

Ledger breakdown (163 rows):

| `source_type` | credit | debit |
|---|---:|---:|
| `transaction` | 150,629.00 | 151,859.00 |
| `transfer` | 118,000.00 | 118,040.00 |
| `loading` | 2.00 | 1,480.00 |
| `gap_fix` | 3,729.00 | — |

This identity is the foundation of the module. It must hold **per branch and in total, for
any period**. When it does not, that is a data fault — which is what Reconciliation already
exists to catch.

### Flows already supported

| Flow | Mechanism | Status |
|---|---|---|
| Credit from owner | `owner_funding` — pending → approve, two-person | ✅ built, has UI |
| Return to owner | `owner_return` — same gate | ✅ built |
| From other branch | `transfers` (`transfer_in` / `transfer_out`), cross-branch allowed | ✅ built |
| Income from transactions | fee on every transaction | ✅ built |
| Income from load | load margin | ✅ built |
| Reversal of a completed row | `pending_reversals` on `entity_type='transaction'` (11 rows today) | ✅ built |
| **Expense from cash on hand** | — | ❌ **no entry path** |

**One flow is missing, not five.**

### Approval machinery already built

`routes/transactions.ts` already provides the exact pattern required:

- creation gate — only controlled types may be born `pending` (line 417)
- approval route — `FOR UPDATE`, branch assert, proposer ≠ approver (line 908), account
  `FOR UPDATE`, insufficient-balance guard, `processTransaction` inside one transaction
- `transactions` already carries `approved_by`, `rejected_by`, `rejection_reason`,
  `transaction_category_id`, `reference_number`, `notes`

---

## 2. The funds-flow model

Every peso entering or leaving a branch belongs to exactly one bucket.

### Sources (credits)

| Source | Type code / source | Exists |
|---|---|---|
| Owner capital injection | `owner_funding` | ✅ |
| Transfer in from another branch | `transfer_in` / `source_type='transfer'` | ✅ |
| Customer cash-in | `cash_in` | ✅ |
| Customer payment | `customer_payment` | ✅ |
| Transaction fee income | `fee` on transactions | ✅ |
| Load margin income | `source_type='loading'` | ✅ |
| Other income | `other_income` | ✅ |
| Refund received | `refund_received` | ✅ |
| Adjustment in | `adjustment_in` / `source_type='adjustment'` | ✅ |
| Gap correction | `source_type='gap_fix'` | ✅ |
| Opening balance | `accounts.opening_balance` | ✅ |

### Uses (debits)

| Use | Type code / source | Exists |
|---|---|---|
| **Operating expense** (rent, payroll, utilities…) | **`operating_expense`** | ❌ **new** |
| Return to owner | `owner_return` | ✅ |
| Transfer out to another branch | `transfer_out` / `source_type='transfer'` | ✅ |
| Load restock paid to provider | `load_purchase` | ✅ |
| Customer cash-out / withdrawal | `cash_out`, `customer_withdrawal` | ✅ |
| Provider charge | `expense` | ✅ *(declared, 0 rows)* |
| Service fee paid | `service_fee` | ✅ |
| Bill payment | `bill_payment` | ✅ |
| Refund paid | `refund` | ✅ |
| Adjustment out | `adjustment_out` | ✅ |

### The invariant

```
closing position = opening balance + Σ sources − Σ uses
```

Holds today, exactly. The module reports this statement and drills into any bucket; it
never rewrites it.

---

## 3. Design decisions

### D1 — The revolving fund becomes an account

A new `cash`-type account **per branch**:

```
Revolving Fund — Main Branch         cash   branch MAIN
Revolving Fund — Reina Mercedes      cash   branch RM
```

**Why an account and not a side table:** an expense must debit something
(`transactions.account_id` is `NOT NULL`), and `balance_after` has to reconcile row-by-row
in the Statement of Account. Making the float an account means ledger, SOA, branch
scoping, reconciliation and balance history all apply **unchanged**. The `cash` account
type already exists and is unused.

Its `current_balance` *is* the float, live.

### D2 — An operating expense is a transaction, not a new table

`transactions` already has everything a pending expense needs: `status`, `approved_by`,
`rejected_by`, `rejection_reason`, `transaction_category_id`, `reference_number`, `notes`.

**Why not a separate `operating_expenses` table:** it would need its own approval queue,
its own branch asserts and its own balance writes — three copies of logic that already
works. Worse, rows living outside `transactions` would not appear in the Statement of
Account, so `balance_after` could no longer be reconstructed row-by-row. That breaks a
stated invariant of this system.

Side benefit: `pending_reversals` targets `entity_type='transaction'`, so **reversal of a
completed expense comes for free** through the existing two-person reversal flow.

### D3 — New type code `operating_expense`; never reuse `expense`

`expense` **already means provider charge**:

```sql
-- reports.ts:627, 759  provider charges = tt.code = 'expense'
-- reports.ts:521, 786  income/cash view = tt.code <> 'expense'
```

Reusing that code would silently move operating costs into the provider-charge column and
corrupt both the Income and Expense tabs. A distinct code is mandatory.

### D4 — Branch derives from the account

The expense inherits `branch_id` from the wallet it debits. **No `branch_id` column is
added to any money table.** This preserves the invariant established by migration 033:
money's branch hangs off `accounts`, so a transaction's branch can never disagree with
where the money actually left.

Cost attribution by branch is therefore only correct if a branch's expenses are paid from
that branch's own wallets — which is the intent, and which the account picker enforces by
defaulting to the branch's revolving fund.

### D5 — Money moves only at approval

Creation writes a `pending` row: **no balance change, no ledger entry.** Debit and ledger
row happen inside the approval transaction, under `FOR UPDATE`, alongside the
insufficient-balance guard.

### D6 — The two-person rule applies to administrators too

Existing owner-fund creation reads:

```ts
requiresApproval = isOwnerFund && !isAdminCreator;   // line 414
```

An administrator creating an owner fund bypasses approval. For operating expenses that is
**wrong** — the business explicitly chose proposer ≠ approver for expenses. So for
`operating_expense`, approval is required **regardless of who created it**, and the
approval route rejects `created_by === approver`.

This is a deliberate, narrow deviation from the owner-fund behaviour and must not be
generalised to owner funds.

### D7 — Cash position is read, never stored

```
position(branch, period) = SUM(current_balance) WHERE branch_id = X
```

Nothing new to keep in sync. Sources & Uses is a pure read over `ledger_entries`,
attributed by `transaction_id → transaction_types.code`, `transfer_id`, and `source_type`
for loading/adjustment/gap-fix rows.

### D8 — Permissions reuse the existing vocabulary

| Action | Permission | Extra |
|---|---|---|
| View cash management | `reports.read` | branch scope |
| Propose an expense | `transactions.write` | branch scope |
| Approve / reject | `transactions.approve` | **+ administrator** + proposer ≠ approver |

No new permission rows. Same shape as owner funds, so role grants already make sense.

---

## 4. Data model changes (migration 034)

1. **Insert transaction type**
   `('Operating Expense', 'operating_expense', 'out')`

2. **Seed the revolving-fund accounts** — one per branch, `account_type = cash`,
   `opening_balance = <actual physical cash on hand>` (**figure needed — see §9**),
   `current_balance = opening_balance`, `owner = 'Company'`,
   `purpose = 'Revolving fund / cash on hand'`.

3. **Categories** — reuse the existing `transaction_categories` rows that already fit
   (`rent`, `salary`, `utilities`, `internet_bill`, `electric_bill`, `water_bill`,
   `bank_fee`, `supplier_payment`, `other_bill`) and add any the business needs. They are
   already a lookup, and grouping by category within `tt.code = 'operating_expense'` cannot
   collide with their use elsewhere.

4. **Down migration** reverses exactly — remove seeded accounts, remove the type, remove
   added categories. Nothing else touched.

No column is added to `transactions`, `accounts`, `branches` or `ledger_entries`.

---

## 5. API surface

All read endpoints take `branchId` (optional, honoured only within the caller's scope),
`startDate`, `endDate`.

| Endpoint | Purpose |
|---|---|
| `GET /cash-management/position` | Per-branch current position and movement over the period |
| `GET /cash-management/flows` | Sources & Uses buckets for the period |
| `GET /cash-management/flows/:bucket` | Drill-down rows behind one bucket |
| `GET /cash-management/summary` | Headline: float, wallets, total, in/out this period |

Write path reuses the existing transaction routes — only the *set of controlled types*
widens:

```ts
const CONTROLLED_TYPES = ['owner_funding', 'owner_return', 'operating_expense'];
```

| Route | Change |
|---|---|
| `POST /transactions` | creation gate accepts `operating_expense` as `pending`; approval not skippable for admins |
| `GET /transactions/approvals/pending` | (generalises `/owner-funds/pending`) include expenses |
| `POST /transactions/:id/approve` | `assertOwnerFundType` → assert controlled type |
| `POST /transactions/:id/reject` | unchanged |

Every query uses the established `detailScope(...)` + `branchClause(...)` pattern used by
the other 13 report endpoints.

---

## 6. UI surface

**New page: Cash Management** (nav item, visible with `reports.read`)

1. **Position cards** — one per branch: current cash, movement in period, float vs wallets
2. **Sources & Uses statement** — the period's buckets with totals, click to drill
3. **Record expense** — account (defaults to the branch's revolving fund), category,
   description, amount, payee, voucher ref, date → creates `pending`
4. **Awaiting approval** — admin queue, propose/approve/reject, showing proposer so the
   two-person rule is visible

**Reports → Income & Expense → Expense tab** gains a third component:

```
totalExpense = serviceFees + providerCharges + operatingExpenses
```

The debit lands on a real account, so the row appears in that account's line with no
change to the report's row structure. CSV export gains the column.

**Accounts** — populate `owner` and `purpose`; both columns exist and are empty.

---

## 7. Acceptance criteria

- **GIVEN** an expense is saved as `pending` **WHEN** re-reading the account
  **THEN** `current_balance` is unchanged and no ledger row exists
- **GIVEN** a pending expense **WHEN** its proposer tries to approve it
  **THEN** `400`/`403` and nothing changes — including when the proposer is an administrator
- **GIVEN** an approved expense **WHEN** it completes **THEN** exactly one debit ledger row
  exists with a correct `balance_after`, and the SOA still reconciles row-by-row
- **GIVEN** an amount greater than the wallet **WHEN** approved **THEN** a readable `400`
  naming the account, balance and amount, with nothing written
- **GIVEN** a completed expense **WHEN** edit or delete is attempted **THEN** refused;
  correction is an appended reversal via the existing two-person flow
- **GIVEN** any branch and any period **WHEN** the Sources & Uses statement is computed
  **THEN** `opening + Σsources − Σuses = closing position` to the centavo
- **GIVEN** a branch-scoped user **WHEN** they open Cash Management
  **THEN** they see only their branches; the administrator sees all
- **GIVEN** the Income tab **WHEN** operating expenses exist **THEN** its totals are
  unchanged — expense money must not leak into income
- **GIVEN** the Expense tab **WHEN** operating expenses exist **THEN**
  `totalExpense = serviceFees + providerCharges + operatingExpenses`

---

## 8. Phasing

| Phase | Deliverable | Risk |
|---|---|---|
| **A** | Migration 034 — type, revolving-fund accounts, categories | schema only, reversible |
| **B** | Controlled-type gate + approval for `operating_expense` | touches money — needs confirmation |
| **C** | Cash position + Sources & Uses read endpoints | read-only |
| **D** | Cash Management page | read-only + entry form |
| **E** | Expense report component + CSV column + tests | read-only |

Phases A, C, D, E write nothing that affects balances. **Phase B is the only one that can
move money** and should be built and reviewed on its own.

---

## 9. Open questions

1. **Opening balance for each revolving fund.** The float has to start from the actual
   physical cash on hand at each branch today. This figure must come from the business —
   it cannot be derived from the system.
2. **Expense categories** — reuse the nine existing codes above, or supply the company's
   real list?
3. **May an expense debit any wallet, or only the revolving fund?** Default: any wallet the
   caller can see, with the revolving fund preselected.
4. **Overdraft.** Default: blocked by the existing `Insufficient balance` guard, matching
   reversal approval. Confirm a company wallet should never legitimately go negative.
5. **`expense` (provider charge) is declared but has 0 rows.** Is that path actually in use,
   or dead code that should be reconciled separately?

---

## 10. The drawer gap

Everything in sections 1–9 shipped. Section 9's question 1 (the float's opening figure) is
still open, and it is the reason the next piece exists: **the `cash` accounts hold ₱0 and
have never held anything.**

Measured against production, 5 Oct 2026:

```
ledger rows on cash-type accounts      0      ← ever
Revolving Fund — MAIN / RM        ₱0.00 / ₱0.00
```

`processTransaction` — the single choke point every transaction already passes through —
posts **one row, to one account**:

```ts
const netAmount = amount;                                     // fee: accepted, never read
const newBalance = await updateAccountBalance(accountId, netAmount, entryType, client);
await createLedgerEntry(accountId, entryType, netAmount, newBalance, ...);
```

Consequences, all measured:

| | Count | Gross |
|---|---:|---:|
| `cash_in` | 60 | ₱124,055 |
| `cash_out` | 48 | ₱105,940 |
| **net physical cash** | | **₱18,115** |
| transactions carrying a fee | 114 | ₱2,950 recorded, **₱0 ever posted** |

The drawer is not merely unstocked — **its leg of every cash movement was never written.**
`payment_method` is `NULL` on all 108 of those rows, so history cannot be classified.

Two terms also collide, and the collision must be resolved before anything counts against
it: the page headline *"Cash on hand now ₱122,372"* is `Σ` of all 17 balances (bank +
e-wallet + cash), while *cash on hand* in the business means **the drawer**. Different
numbers, same words.

---

## 11. Design decisions

### D9 — The drawer gets a counterparty leg, not a rewrite

`processTransaction` gains an **optional counterparty account**. When present it posts a
second `ledger_entries` row and updates the second balance, inside the same client
transaction as the first.

**Why a second row rather than a new table:** the drawer must appear in the Statement of
Account with a reconstructible `balance_after`, and must be reachable by branch scoping,
reconciliation and reversal. All four already work for ledger rows. A side table would get
none of them.

The tie-out survives by construction — every balance change still has a matching row — so
`opening + Σsources − Σuses = current` continues to hold per branch and in total.

### D10 — The leg is gated by payment method

`paymentMethodOptions` already distinguishes the four ways money arrives:

| Method | Drawer participates? |
|---|---|
| `cash` | **yes** — the operator physically takes from or receives into the drawer |
| `gcash`, `bank`, `maya` | no — the money lands in the e-wallet or bank account directly |

This is the business rule verbatim: *if a customer cashes out, the operator takes the money
from the cash on hand.* It only applies when the movement is physical cash.

### D11 — `payment_method` becomes mandatory; history is never backfilled

Going forward `payment_method` is `NOT NULL` on cash movements, because the drawer leg
cannot be decided without it. The 108 historical rows stay `NULL` and stay single-leg.

**Why not backfill:** classifying them would mean *deciding* which of them were physical
cash, and the system has no record of it. Inferring it would be fabricated data, which this
system does not do. All existing statements, reports and balances are therefore unchanged.

### D12 — The fee lands in the drawer *and* stays report income

Business answer, recorded: **"report as income and add the charge in cash drawer."**

The fee does two things and never one at the expense of the other:

- **Income report unchanged** — it reads `t.fee` and reports `₱2,950` exactly as before.
- **The peso is physically retained in the drawer** — it now has a ledger leg.

Both existing modes collapse to one formula:

```
drawer_delta = wallet_delta + fee
```

| Mode | Wallet | Physical cash | Drawer | Fee |
|---|---:|---:|---:|---:|
| Cash-in, deducted | +490 | 500 | **+500** | 10 retained |
| Cash-in, separate | +500 | 510 | **+510** | 10 retained |
| Cash-out, separate | −500 | 490 | **−490** | 10 retained |
| Cash-out, deducted | −500 | 490 | **−490** | 10 retained |

> **Direction corrected in D24.** The formula above and the *Drawer* column had the drawer
> moving **with** the wallet. It moves **against** it. The fee's treatment here — report income
> *and* credit the drawer — is unchanged; only the sign of the movement under it moved. D24
> carries the corrected table.

> ⚠️ A peso now appears in *both* the Income report and the cash statement. That is
> correct — they answer different questions, as section 1 states — but **the two must
> never be added together.** Recorded here so no future report does so by accident.

### D13 — Deducted mode must not shrink a debit

Today `netAmount = amount − fee` is posted for **both** directions. For a cash-out that
means the wallet drops ₱490 and ₱490 is handed over: **the ₱10 fee is collected from
nobody**, while the Income report books it as earned. A recorded income that was never
physically collected is a hole in the books.

Corrected, and it is the only change to existing posting behaviour in this section:

| Direction | Posted to wallet |
|---|---|
| credit | `amount − fee` — *already correct* |
| debit | **`amount`** — *corrected*; customer receives `amount − fee`, `fee` stays in the drawer |

Without this the account drops less than the movement it recorded, and the fee is reported as
earned out of an amount nobody paid. D24 restates the drawer's own side of that row; the debit
rule above is unchanged by it.

### D14 — A shift is a count, never a movement

Opening and closing record **what was counted**. Neither writes a balance and neither writes
a ledger row. The expected figure is arithmetic over movements that already exist:

```
expected closing = counted opening float + Σ cash in during shift − Σ cash out during shift
variance         = counted closing − expected closing
```

**Why a count must not move money:** a discrepancy is an event needing investigation, not a
balance to be adjusted. This is the same shape `reconciliations` already uses
(`expected_balance`, `actual_balance`, `variance`, `status`), at branch granularity instead
of per account.

### D15 — One open shift per branch

A branch's drawer has one physical state, so it can have exactly one open shift — enforced
by a partial unique index, not by application code alone. Anyone working the branch operates
under it; `opened_by` is accountable for the close.

### D16 — Two readings, deliberately cross-checked

The shift's expected figure comes from **its own counted opening float plus movements**.
The drawer's `current_balance` is a **separate** reading that must converge on it. When they
disagree, that is the signal the drawer leg or the counting is wrong — so both are shown,
and neither is derived from the other.

This is why the drawer must be real before the first shift opens: counting against a ₱0
drawer would report a false variance on every single shift, and a reconciliation that is
always wrong is one operators learn to ignore.

---

## 12. Data model changes (migrations 036–037)

1. **`payment_method`** — a value check on `transactions`:
   `CHECK (payment_method IS NULL OR payment_method IN ('cash','gcash','bank','maya','provider_interest'))`.
   Every value already stored satisfies it (`bank` 2, `provider_interest` 1, `gcash` 1,
   `NULL` 125), so it validates the existing rows without a rewrite.

   **A `NOT NULL` check scoped to the cash-movement codes was specified here and is now
   rejected.** It would have been declared `NOT VALID` to spare the 108 historical `NULL`
   rows, but `NOT VALID` still constrains *updates*, and reversal rewrites the original row
   (`transactions.ts` lines 798 and 1095). Every historical cash movement would have become
   un-reversible the moment the migration ran, and backfilling them would have meant
   guessing which were physical cash. Presence is instead enforced where the row is created,
   and the column-level constraint guarantees only that a stored value is one the system
   understands — which is what stops the drawer gate from silently skipping an unrecognised
   code.

2. **Application-level presence** — `cash_in`, `cash_out`, `customer_payment`,
   `customer_withdrawal` require `paymentMethod` on create, restricted to `cash` / `gcash` /
   `bank` / `maya`. Creation is the only writer for these types — the edit path refuses any
   row that is not pending, and a cash movement is always completed — so an edit-time rule
   would have nothing to act on.

   Two writers deliberately sit outside it. The correction/re-entry path copies
   `payment_method` from the row it clones, so a re-entered movement keeps its method. The
   CSV import path writes its own ledger row rather than going through `processTransaction`
   and leaves the column `NULL`: imported rows are backfill, and treating them as
   historical — single-legged and unclassified, exactly like the 108 — is the same decision
   D11 already made for pre-existing data. The requirement applies to movements an operator
   raises, not to rows being loaded in.

3. **`shifts`** table:

   ```sql
   id               UUID PK DEFAULT gen_random_uuid()
   branch_id        UUID NOT NULL REFERENCES branches(id)
   status           TEXT NOT NULL CHECK (status IN ('open','closed'))
   opening_float    NUMERIC(15,2) NOT NULL CHECK (opening_float >= 0)
   opened_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
   opened_by        UUID NOT NULL REFERENCES users(id)
   counted_closing  NUMERIC(15,2)           -- NULL while open
   expected_closing NUMERIC(15,2)           -- computed at close
   variance         NUMERIC(15,2)           -- counted − expected
   closed_at        TIMESTAMPTZ
   closed_by        UUID REFERENCES users(id)
   notes            TEXT
   created_at / updated_at
   ```

   **Partial unique index:** `UNIQUE (branch_id) WHERE status = 'open'`.

4. **Down migration** reverses exactly: drop `shifts`, drop the value check. No
   `accounts`, `transactions` or `ledger_entries` column changes.

`TIMESTAMPTZ` throughout, `NUMERIC` for all money, UUID PK, `createdAt`/`updatedAt` — as
required by the repository conventions.

---

## 13. API surface

| Endpoint | Purpose |
|---|---|
| `GET /cash-management/shifts?status=&branchId=` | Open shifts — each carrying a live expected figure, the drawer's book balance and the gap between them — or closed history. Branch-scoped. |
| `POST /cash-management/shifts/open` | `{ branchId, openingFloat, notes? }` → creates `open` |
| `POST /cash-management/shifts/:id/close` | `{ countedClosing, notes? }` → computes expected and variance, returns both readings |
| `GET /cash-management/shifts/:id/movements` | The drawer's cash movements inside the shift window |

Permissions reuse the existing vocabulary — `reports.read` to view, `transactions.write` to
open and close. **No new permission rows.** Opening and closing move no money, so they need
no approval gate of their own; the variance they produce is what gets investigated.

---

## 14. UI surface

On the existing **Cash Management** page:

1. **Headline split** — the total is *Total on the books*, every account balance (the
   drawer included), shown with *Accounts (non-cash)* — that total less the drawer — beside
   the drawer's own figure, *Cash on hand*. The drawer is one of the accounts in the total,
   never a separate pot: the three read `non-cash + cash on hand = total`. They are never
   summed.
2. **Shift banner** — closed → an **Open shift** form (float + date + notes); open → the
   current shift with elapsed time and a **Close shift** action.
3. **Close dialog** — enter counted cash, and show **before confirming**:
   ```
   counted opening    ₱10,000.00
   + cash in          ₱ 2,400.00
   − cash out         ₱   900.00
   = expected         ₱11,500.00
   counted            ₱11,450.00
   variance           ₱   −50.00   ← SHORT
   ```
4. **Variance badge** — `BALANCED` / `OVER` / `SHORT`, echoing the reconciliation badge
   vocabulary already in use.

---

## 15. Acceptance criteria

- **GIVEN** a cash-out of ₱500 with a ₱10 deducted fee **WHEN** it completes **THEN** the
  wallet drops ₱500, the drawer drops ₱490, and one ledger row exists for each
- **GIVEN** a cash-out with `payment_method='gcash'` **WHEN** it completes **THEN** only the
  wallet row is written — no drawer row
- **GIVEN** a cash movement with `payment_method` absent **WHEN** submitted **THEN** `400`
  naming the field, with nothing written
- **GIVEN** a completed cash movement **WHEN** either edit or delete is attempted **THEN**
  refused; correction remains an appended reversal
- **GIVEN** any branch and any period **WHEN** the statement is computed **THEN**
  `opening + Σsources − Σuses = current` to the centavo, per branch and in total
- **GIVEN** historical transactions **WHEN** the statement is recomputed for a past period
  **THEN** every figure is byte-identical to its value before this work
- **GIVEN** a second shift opened at the same branch **WHEN** submitted **THEN** refused by
  the partial unique index, not merely by a UI check
- **GIVEN** a shift opened at ₱10,000 with ₱2,400 in and ₱900 out **WHEN** closed counting
  ₱11,450 **THEN** expected is ₱11,500 and variance is −₱50.00, reported as `SHORT`
- **GIVEN** a shift close **WHEN** it completes **THEN** no balance and no ledger row has
  changed — the count wrote only `shifts`
- **GIVEN** the Income tab **WHEN** fees have drawer legs **THEN** `totalIncome` is
  unchanged at its pre-existing figure

---

## 16. Phasing — one piece, fixed internal order

| Phase | Deliverable | Moves money? |
|---|---|---|
| **F1** | Counterparty leg in `processTransaction` + unit tests on the pure aggregation | **yes** — reviewed alone |
| **F2** | `payment_method` mandatory, gating the leg | no (constraint only) |
| **F3** | Fee retained in the drawer; D13 debit correction | **yes** — reviewed alone |
| **G1** | Migration 036 — `shifts` table | no (schema only) |
| **G2** | Shift endpoints + pure expected/variance engine + tests | no (read + count) |
| **G3** | Shift UI, headline split, close dialog | no |

**The order is the safety property.** Shifts are a reconciliation, and a reconciliation
against a drawer that reads ₱0 produces only a false variance. The first shift must not open
until F1–F3 have made the drawer real.

Phases F1 and F3 are the only two that can move money. Each is built and reviewed on its
own, exactly as Phase B was.

---

## 17. Questions resolved since §9

| # | Question | Resolution |
|---|---|---|
| 1 | Opening balance for the float | **Shift opening float** is the mechanism — the operator enters the physical count when opening the first shift. No manual balance edit. |
| 2 | Expense categories | Reuse the nine existing codes; nothing seeded. *(delivered)* |
| 3 | May an expense debit any wallet? | Any visible wallet, revolving fund preselected — matching this user's branch. *(delivered)* |
| 4 | Overdraft | Blocked by the existing guard. *(delivered)* |
| 5 | `expense` provider-charge path, 0 rows | **Resolved by D34.** Not dead code — it is the provider-charge path, and it has never run because no operator has ever entered a provider charge (0 rows carry `linked_transaction_id` anywhere). The form has no free type picker, so the type was reachable only over the API, where a hand-typed row would have settled instantly with no fee guard. |

New, carried into implementation:

1. **Is `Σ account balances` still a meaningful figure once both legs post?** The accounts
   were confirmed company-owned in §1. Posting both legs makes the statement report *gross*
   movement rather than net, which is correct for *"where did cash move"* but inflates
   Sources and Uses. **Accept, and label the headline accordingly** — or, if the figure is
   meant to be net company funds, the statement needs a netting view. Flagged rather than
   assumed: the tie-out holds either way, so this is a reporting question, not a
   correctness one. *(decided: accept and label the headline — §27)*
2. **`payment_method` on operating expenses** — an expense paid from the drawer is
   physical by definition. Confirm it should be forced to `cash` when the account is
   `cash`-typed, rather than left to the operator. *(resolved by D33: confirmed, and
   broader than expenses — the rule is the account's, not the type's)*

---

## 18. No open shift, no money movement

Requirement, added after §10–§17 were built:

> The system cannot transact cash transactions, fund transfers, and loading without an
> open shift.

This is a **precondition**, not a reconciliation: it compares nothing, it refuses.

### D17 — An open shift is a precondition for moving a branch's money

**The rule.** A branch with no open shift may not move money. The check is on the *branch*,
never on the user: an administrator holding `*_write_all` is refused exactly like a teller,
because the drawer's physical state is not a permission.

**There is no override.** A bypass permission would make the rule advisory — the first
person to find it would use it, and the record would show the movement happened anyway. If
something genuinely must be recorded with no shift open, the answer is to open a shift and
record it there.

**Where the check does not go.** Three candidates were rejected:

- **Not in the database.** The precondition is temporal — *a row with `status='open'` exists
  now* — not relational, and it would have to be evaluated inside every write path anyway,
  including the raw-SQL ones.
- **Not inside `processTransaction`.** §11 calls it the single choke point and for
  transactions it is one. But transfers post through `moveTransferFunds`
  (`routes/transfers.ts:99`) and loading through inline SQL (`routes/loading.ts:183`), so a
  gate there would exempt two of the three flows this requirement names — *silently*, since
  those two would keep working.
- **Not folded into `assertBranch`.** It returns early for `*_write_all` holders
  (`middleware/scope.ts:128`), which is precisely the population that must still be refused;
  and it is called by `POST /:id/reject`, which moves no money and must not be gated.

**Therefore:** a standalone guard, called explicitly wherever an account id is already in
hand — one indexed lookup, deliberately uncached, so a shift closed a second ago reads as
closed now. The message names the branch, because "open a shift" is useless advice if you
do not know which one.

**The line that decides scope: a branch *operation* is gated; owner funding and back-office
record-keeping are not.**

| Gated | When money moves |
|---|---|
| `POST /transactions` — every type **except** `owner_funding` / `owner_return` | at create unless forced `pending`, else at approve |
| `POST /transactions/:id/approve`, `/:id/reverse`, `POST /transactions/reversals/:id/approve` | at settle |
| `PATCH /transactions/:id/charges` when the delta is non-zero | at patch |
| `POST /transfers`, `POST /transfers/:id/approve`, `DELETE /transfers/:id` on a completed transfer | at create (admin) / approve / unwind |
| `POST /loading`, `DELETE /loading/:id` | at create / unwind |
| Corrections: `apply`, `re-enter`, `gap-fixes/:id/approve` | at apply |

| Exempt | Why |
|---|---|
| `owner_funding`, `owner_return` | This is how the drawer *gets* its float. Gating it would make §16's "fund the revolving funds first" impossible, and it is owner activity rather than branch traffic. |
| CSV import (`/import/transactions`, `/import/loading`) | Backfill of activity that already happened. Import carries no branch scoping at all today, so gating it here would block history rather than live trading. **Known bypass — flagged, not hidden.** |
| Admin balance edit, reconciliation adjust | Correcting a *record*, not operating the branch. |
| reject / notes / status routes, loading product CRUD | No money moves. |

**Which branch.** Transfers gate on the **source** branch only. Cross-branch transfers are
explicitly allowed (§1) and the destination sits outside write authorization by design
(`routes/transfers.ts:165-171` — an incoming credit needs no permission from the branch
receiving it). Gating the destination too would let an unrelated branch block an outgoing
transfer by simply going home. Transactions and loading involve one account, hence one
branch.

**Both create and settle.** Gating only settlement would let an operator build a queue of
pending rows that nobody can complete; gating only creation would let money move after
close through the approval button. Both are the same one check at two points the code
already reaches.

**Unwinds are gated too**, and the consequence is deliberate: a mistake made under a closed
shift can only be corrected while the *current* shift is open. History is forward-only, so
the correction is recorded under today's count rather than by reopening yesterday's.

**Response: 409**, carrying the remedy —
`No open shift for branch <code> — open a shift before recording money movements.` 409
rather than 400 because the request is well-formed and authorized and it is the *world*
that disagrees; 403 is wrong because nothing was forbidden.

**Accepted limitation.** The guard runs as its own statement rather than inside the
movement's transaction: `POST /transactions` performs its insert on the pool while its
`BEGIN`/`COMMIT` run on a separate client, so there is no single place all three flows
share. The window is one query wide against an operator action taking seconds. A shift that
closes inside it leaves a correctly-recorded movement against a closed count — which is
what variance exists to catch.

**Phasing — this piece is last.**

| Phase | Deliverable | Moves money? |
|---|---|---|
| **H1** | Guard + the three named flows (create, settle, unwind) + tests | no |
| **H2** | Corrections and `PATCH /:id/charges` join the gate + tests | no |
| **H3** | UI reads shift state and refuses early instead of on submit | no |

Deploy order is unchanged from §16 and this lands at the end of it: migrations 036/037 →
fund the drawers → frontend, so operators *can* open a shift → open a shift → then this.
**On the day it lands every branch starts blocked until someone opens a shift.** That is the
intended first action of the day, but it should be chosen rather than discovered.

---

## 19. Live on Cash Management, periods in Reports

The From/To pair on the Cash Management page was only ever half-applied. The two headline
cards read `current_balance` and ignored the period entirely, so changing the date moved the
middle of the page and not the top; and the amber *"closing ≠ live balance"* state existed
only because a period can end before today. None of the page's actual job — what is in the
drawer, is a shift open, what needs approval — is a period question at all.

### D18 — the period belongs to Reports

**Cash Management** keeps the headline (books and drawer as two separate figures), the shift
section, Record expense and Awaiting approval, and shows a **live** per-branch position. No
date filter. Its figures are always *now*, which removes the half-applied asymmetry and the
amber state with it.

**Reports** takes the Sources & Uses statement and its drill-down as a report type. It is
period analysis, and Reports already owns eight period-filtered reports with print and CSV.

The statement is *moved*, not rebuilt: `buildCashStatement`, its buckets and its drill-down
are unchanged.

### D19 — Reports gets one branch picker, validated like every other scope

1. `branchId` joins the shared `filters` state and renders for **every** report type — From
   and To already render unconditionally, and every report's rows derive from accounts, which
   all have a branch.
2. Options come from `GET /branches`, which is already scoped, so an operator is offered
   their own and head office all of them.
3. Choosing a branch **narrows the Account dropdown** to that branch's accounts and clears an
   `accountId` that does not belong to it. A contradictory pair returns nothing, and nothing
   reads exactly like a report with no data — the worst possible failure for a report.
4. The server validates once per endpoint and answers **404 when the branch is outside the
   caller's scope** — the same convention as `assertBranch` and `assertShiftBranch`. Answering
   with an empty result instead would be indistinguishable from a genuine empty report, and
   would let a scoped caller probe for branches.
5. The printed `Scope:` follows **the filter, not merely the caller's identity**. Today it is
   derived from `user.branches`, so without this an RM-only PDF would be stamped *"Scope: All
   branches"* — precisely the failure the comment at `Reports.tsx:51-54` was written to
   prevent.
6. Branch is the **account's** branch. For the transfer report that is the *source* account's
   branch, matching how authorization already treats a transfer.

### D20 — every row names its branch; aggregates subtotal per branch

- Row-level reports (transaction, transfer, loading, reversal) gain a **Branch** column.
- Aggregate reports (Income, Expense, Consolidated) show a **subtotal per branch** above the
  grand total whenever the view spans more than one branch — the same shape the position
  statement already uses.

Implemented by adding `branch_id` and `branch_name` to each report's row payload and grouping
in the renderer, rather than by re-deriving any report's SQL. A report's numbers must not be
recomputed by a second implementation just to slice them differently; the same rows, grouped
differently, cannot disagree with the total they sit under.

**Phasing**

| Phase | Deliverable | Moves money? |
|---|---|---|
| **R1** | Branch picker, server validation, account narrowing, print scope | no |
| **R2** | Branch column + per-branch subtotals | no |
| **R3** | Statement moves to Reports; From/To leaves Cash Management | no |

R1 first because it shapes the other two: R2 needs the branch on the row, and R3's statement
is per-branch by construction.

**All three shipped.**

R2 groups in the renderer wherever rows exist: transaction, transfer and loading carry
`branch_name` straight off the query, income, expense and reversal carry `branchName`, and the
subtotals a foot prints are sums of the rows directly above them — so a subtotal cannot
disagree with the total it sits under. Consolidated is the exception, because it has no rows to
group: its five figures are now each asked **once** with `GROUP BY branch`, and the grand total
above them is that same grouping summed rather than a second query over the same rows.

R3 moved the statement into Reports as the **Sources & Uses** report type, reading
`/cash-management/statement` with From/To — `buildCashStatement` and its drill-down never left
the server, so nothing was reimplemented. Cash Management keeps calling the endpoint with no
period, because a live position has no period of its own (D18).

Giving the statement a period exposed a defect it had never been able to show: both ends of
`entryDateBounds` used to be built from the instant, and `end`'s UTC day is one behind its
Manila day. Oct 6 00:00 Manila is Oct 5 16:00 UTC, so a period ending Oct 6 bound
`entry_date < 2026-10-06` — silently dropping the last day of every figure while the echoed
period still read Oct 1–6. It stayed dormant because Cash Management sent no dates at all
before this. The bound now names the day the operator picked, and
`src/test/manilaTime.test.ts` pins it.

### D21 — the one period Cash Management may name is its own shift

D18 removed the page's From/To because a live position has no period of its own. It does have
a shift, and the shift has a day: every transaction in that branch is already held to
`shift_date` (D17), so the open shift's date is a window the page derives rather than one a
user supplies. **Income and expense for that day** therefore sit on Cash Management without
reopening the filter D18 closed — there is still nothing to pick.

`GET /reports/shift-activity` (`reports.read`, `branchId` validated through
`resolveBranchFilter` so a foreign or malformed branch answers 404 rather than an empty view):

- **Period** — `shift_date` of each open shift in the caller's scope, per branch. Branches may
  disagree about the day, so the payload carries the set of dates and a per-branch row instead
  of one label that would be false for the rest.
- **Figures** — the Income and Expense report's own components, from the same
  `loadIncomeReport` / `loadExpenseReport` called once per open shift. Not a second
  implementation restating their conditions: two readings of one rule can agree by
  construction, two rules cannot. Transaction fees and load margin are income; transfer
  service fees, provider charges and recorded operating expenses are expense — a transfer's
  fee still stays out of income, because the sender is debited the amount plus it and the
  receiver credited only the amount (`incomeReport.ts`, `expenseReport.ts`).
- **Absence** — a branch with no open shift is absent, and the panel says so. Inventing a
  window for it would be inventing a period the books never recorded.

Cash Management keeps no date input; Reports keeps every other period.

### D22 — the register lists what exists, without a period

The position above answers *where the cash is now*. It does not answer *what has been recorded
against it* — a reader auditing their own data entry has to open the statement in Reports and
pick a range, which is the range they do not yet know. So Cash Management gains a **register**:
every ledger row that touched a branch's cash accounts, newest first.

- **It carries no date filter, and that is not a conflict with D18.** A list of what exists is a
  point-in-time question, not a period question; D18 removed a From/To pair that fed the
  headline figures. The register narrows by branch, by class and by a text search — never by a
  date. A reader who wants a period uses Reports.
- **It is classified by `bucketFor` in code, not by a second SQL `CASE`.** The same function the
  position statement totals by classifies each row, because a list that disagreed with the
  figures it sits under would be worse than no list. The drill-down (`/statement/drill`) already
  made this choice for the same reason; the register follows it. The whole scoped population is
  read once — the same set `/statement` already reads unbounded — and filtered, classified and
  paged in code.
- **The classes offered are built from that population**, with their counts, so the Type
  dropdown can neither offer a class that yields nothing nor hide one that yields rows.
- **Scope matches the statement's own data**: `accounts.read_all` through
  `resolveBranchFilter`, so a foreign or malformed branch answers 404 rather than an empty view,
  and a branch-scoped operator sees only their branch's cash.
- **`GET /cash-management/records`** (`reports.read`) serves the page and, with `format=csv`, the
  whole filtered register as a file. The export is narrowed exactly as the screen is but is not
  clipped to the visible page, writes a BOM, and reads each date in Manila (`manilaDateTimeKey`)
  so a row filed Oct 8 in Manila is not exported as Oct 7 — the same off-by-a-day D21 closed for
  reports. `CashRecordRow` and `cashRecordsCsv` are pure and pinned by
  `src/test/cashManagement.test.ts`.
- **A row is filed under its business day.** The register's *Date* is the transaction's
  `transaction_date` (the day the operator named, D17), falling back to the posting instant for a
  row with no transaction — a transfer, adjustment or gap fix. The instant the row actually hit
  the drawer (`entry_date`) is printed beside it as *Posted*, because an expense entered for Sep
  25 and posted into the drawer on Oct 7 is one of those two dates and the reader has to be able
  to tell which. The list is ordered by the same filed day, so the order matches the dates on
  screen: a back-dated row for Sep 25 is neither listed nor sorted under the Oct 7 it was posted.
  This is why the two dates are carried apart rather than collapsed — the drawer's balance moved
  on one of them and the books were told the other.
- **Anonymous classification.** A row whose source the classifier does not recognise still
  appears, under *Other*, rather than vanishing from the drawer's complete history. A shift float
  gets its own *Opening Float* class: a shift writes no ledger row today, so the class exists to
  name one the moment one is posted, not to leave it reading as an unexplained correction.

The register sits **outside the statement's render branch**, so a statement that fails to load
does not take the drawer's own history down with it. The register is what a reader opens to check
a figure; it renders whatever the position above it is doing.

### D23 — the drawer is inside the total, and the page says so

The headline's total (*Total on the books*) is `Σ` of **every** account balance, and the drawer is
one of those accounts — a `cash`-type account with a balance its own ledger rows move. So the
drawer's figure is a **component** of the total, not a second pot beside it, and the page must
never let the two read as additive.

The old labels were the whole problem: *Current accounts* (sub *"Every account balance,
totalled"*) and *Cash on hand* (sub *"Held in the branch drawers"*) put a total and one of its
parts next to each other with nothing saying so, which is exactly what invites a reader to add
₱253,154 + ₱130,782 and double-count the drawer. Section 14.1 said *Total funds on the books* /
*Cash in branch* and "the two are never summed"; the shipped page had drifted from it.

- **The maths does not change.** The drawer stays inside the total, because it is an account: the
  branch tie-out `opening + Σ sources − Σ uses = current` counts every cash row, and dropping the
  drawer from the total would make the header untrue and break that identity.
- **The page makes the relationship explicit.** *Total on the books* — sub *"Every account
  totalled — the cash drawer is included"*; *Cash on hand* — sub *"In the branch drawers —
  already counted in the total"*; and a derived *Accounts (non-cash)* card, `total − drawer`,
  so the three read `non-cash + cash on hand = total` at a glance. The non-cash figure is derived
  in the page, not served, so the cards cannot disagree about scope; it is omitted, not shown as
  zero, when the drawer is absent from an older backend.
- **This is labelling, not accounting.** No balance, ledger row, or invariant moves. It exists so
  a reader auditing the position cannot mistake a component for a peer.
- **One caveat carried forward.** When a `payment_method = 'cash'` movement posts, D9/D12 write a
  drawer leg *in addition to* the wallet leg. Today no transaction posts to both a cash and a
  non-cash account (0 rows; every cash movement has a null method), so the total double-counts
  nothing live. Whether the two legs are genuinely two assets or one asset seen twice is a
  question for D12's own review before the total is leaned on as a valuation. **Answered by
  D24:** the legs run *opposite*, so the pair is a transfer between two pools rather than a
  second asset — the total gains only the fee, never twice the movement.

### D24 — the drawer moves against the account, not with it

D12 wrote the counterparty leg in the **same** direction as the account leg, and `planPostings`
documented that as deliberate: *"a cash-in puts money into the customer's wallet and into the
drawer... this is not a transfer between two accounts."* It is one. The drawer and the account
are two pools of the same company's money, and a cash movement moves value between them.

The operator's rule, recorded:

| | Account | Drawer | Income | Drawer net | Books |
|---|---:|---:|---:|---:|---:|
| **Cash in** | +500 | −500 | +10 | **−490** | **+10** |
| **Cash out** | −500 | +500 | +10 | **+510** | **+10** |

So the drawer's side is `fee − signedAmount` — the sign of the account leg flips. What that buys
is one identity, true in every combination of direction and fee mode:

```
signedAmount + drawer_delta = fee
```

The books grow by exactly the fee, which is exactly what the income report books. Under D12's
`signedAmount + fee` the sum was `2 × signedAmount + fee`: a ₱500 cash-in added **₱990** to the
total while the income report said ₱10.

| Mode | Account | Drawer | Fee | Books |
|---|---:|---:|---:|---:|
| Cash-in, separate | +500 | **−490** | 10 | +10 |
| Cash-in, deducted | +490 | **−480** | 10 | +10 |
| Cash-out, separate | −500 | **+510** | 10 | +10 |
| Cash-out, deducted | −500 | **+510** | 10 | +10 |

- **The change costs nothing, because the path had never run.** Measured before shipping:
  0 of 131 transactions carried `payment_method = 'cash'`, every transaction had exactly one
  ledger row, and none posted to both a cash and a non-cash account. No balance in production
  came from `drawerLeg`, so no balance needed correcting and no row was rewritten. No migration.
- **The guard lands where it should.** `resolveDrawerLeg` refuses a debit the drawer cannot
  fund. With the sign flipped, a cash-in *is* the drawer's debit, so *"the branch's cash drawer
  holds X but this movement hands out Y"* now protects the direction that actually hands money
  out. This is a new operator-facing refusal — recording a cash-in the drawer cannot fund is a
  400 rather than a silent overdraft, which is the correct outcome and worth expecting.
- **One net row, not two.** The table above draws the drawer as −500 then +10; the ledger writes
  a single −490 row. D9 already specifies *a* second row (singular), `CounterpartyLeg` is one
  object, and the transaction still carries `fee`, so the split stays recoverable in the
  register and the Statement of Account. Two rows would widen the change across `planPostings`
  and the balance-after sequencing for no gain in information.
- **`planPostings` still decides nothing.** It writes what the caller gives it; only its
  comment claimed otherwise. The direction now lives where it always should have — in
  `drawerLeg`, one tested expression.

The identity is pinned by a test asserting `signedAmount + drawer_delta === fee` across every
direction and fee mode, so reintroducing the same direction fails the suite rather than quietly
inflating the total.

---

## 20. The books after the test data

On 8 Oct 2026 the module's own test data was taken out of production so that every figure
below it could be read as real. The rule held throughout: **snapshot first, guard the write,
confirm before `COMMIT`** — and never move a balance by hand when deleting rows will do.

What was removed, and how it verified:

| Removed | Result |
|---|---|
| 4 test shifts | `shifts` table → 0 rows |
| Transactions #252, #253 | drawer → **₱0.00** exactly, with no manual balance edit |

The zero is not an edit, it is D7: *cash position is read, never stored*. The drawer's figure
is `Σ current_balance` over `account_types.code = 'cash'` (`cashManagement.ts:140-148`), so
deleting the rows that held the money returns the reading to zero by construction. Opening a
shift writes only `INSERT INTO shifts (...)` — never a balance, never a ledger row (D14).

The owner funding that stocked the drawer (**#256**, ₱131,827) was then recorded by the
operator through the UI rather than written by the agent. An earlier operator shift had opened
against an empty drawer, and the system did the right thing: it surfaced
`live.drawerDifference = 131827` rather than quietly reading ₱0 as a full float.

### The six "mismatches" this exposed were the query's, not the books'

Reading the books after the cleanup appeared to find six accounts whose stored balance
disagrees with the sum of their own ledger rows — ₱121,391 unexplained in total. It was
neither unexplained nor a fault. The query compared `current_balance` against `Σ
ledger_entries` alone and left out `opening_balance`, the first term of the identity in §1:

```
current_balance = opening_balance + Σ credits − Σ debits
```

Exactly six accounts hold a non-zero `opening_balance`, and they are precisely the six
reported — each one's opening balance equal to the "difference" it was reported against,
to the centavo:

| Account | `opening_balance` | Ledger delta | Rows | Stored `current_balance` | Check |
|---|---:|---:|---:|---:|:--:|
| Kristine Mae (e-wallet) | 70,020.00 | −70,020.00 | 2 | 0.00 | ✓ |
| Steven Joe (bank) | 30,623.00 | 0.00 | 0 | 30,623.00 | ✓ |
| Benito (bank) | 17,552.00 | 32,472.00 | 15 | 50,024.00 | ✓ |
| Steven Joe (e-wallet) | 1,387.00 | 700.00 | 1 | 2,087.00 | ✓ |
| Jed (e-wallet) | 972.00 | 931.00 | 111 | 1,903.00 | ✓ |
| Joyce (e-wallet) | 837.00 | 20,630.00 | 8 | 21,467.00 | ✓ |
| **Total** | **121,391.00** | | | | ✓ |

`Σ opening_balance` across the whole chart of accounts is **121,391.00** — the figure once
reported as unexplained is exactly the term the query omitted. A `GROUP BY` over every
account, testing `abs(current_balance − (opening_balance + ledger_delta)) > 0.009`, returns
**zero rows**: §1 holds per account and in total, not merely in aggregate.

Nothing was repaired because nothing was broken. No balance, transaction or ledger row was
written to reach this conclusion — it is a read and a correction to this paragraph.

---

## 21. Business dates are corrected, not rewritten

Two reports disagreed with the page by a day or two, twice, and both were the same defect: a
**business day** stored as something other than the day the money belongs to. The fix is the
same each time, and the rule it encodes is narrow — *the business day moves; the posting
instant never does*.

### D25 — the business day moves; the posting instant never does

The Income Report's ₱2,747 disagreed with the shift panel's figure by **₱98**, all of it
2026-09-28 activity: fees ₱90.00 (#126 cash_out ₱80, #130 cash_out ₱10) and ₱8.00 load margin
(loading #16).

It was never arithmetic. Both panels call the same loader, `loadIncomeReport`
(`reports.ts:753`); the shift panel passes `startDate = endDate = shift_date`
(`reports.ts:1026`) while the Income Report defaults to `''`/`''` — all history
(`Reports.tsx:83`). The gap was a **window**, and the seven transactions plus loading #16 sat
on the wrong day inside it.

| Moved | By |
|---|---|
| `transactions.transaction_date` (7 rows) | `− INTERVAL '3 days'` |
| `ledger_entries.entry_date` (7 rows) | `− INTERVAL '3 days'`, wall-clock time preserved |
| `loading_transactions.created_at` (loading #16) | `− INTERVAL '3 days'` |
| **`ledger_entries.created_at`** | **never touched** |
| **any `amount`, `fee`, `balance_after`** | **never touched** |

Why `created_at` is sacred: `ledgerAudit.ts:62-65` walks rows in `created_at` order, not
`entry_date`, so the balance-after chain and the audit result are provably unaffected —
`chain_breaks = 0` before and after.

The commit script was derived from the verified dry run with the diff asserted to be exactly
one line (`ROLLBACK` → `COMMIT`) before it was allowed to run. Snapshot:
`backup-before-redate-20261008.dump`.

**Result:** all three readers now agree at **₱2,747.00** — the shift panel, the Income Report
across all history, and the Income Report filtered to 2026-09-25.

### D26 — transfers file under the day their ledger rows do

The same defect one table over. `TRF-2026-000025` and `TRF-2026-000026` carried
`transfer_date` on **2026-09-26** while the other six transfers were already on 2026-09-25 —
they were entered late on 28 Sep but belong to the 25th.

A correction in only one place would re-open the same gap, because the two sides read
different columns: every report windows transfers on `tr.transfer_date` (income `reports.ts:770`,
expense `:868`, detail `:1118`, transfer report `:284`) while the statement windows on
`l.entry_date`. Both moved together, `− INTERVAL '1 day'`, wall-clock time preserved:

| Table | Rows | Column moved | Untouched |
|---|---:|---|---|
| `transfers` | 2 | `transfer_date` | `created_at`, `completed_at` |
| `ledger_entries` | 4 | `entry_date` | `created_at` (the audit's order key) |

Guards asserted before the write: 2 transfers / fees ₱20.00 / 4 ledger rows / transfer-vs-ledger
day agreement / 0 chain breaks. Unchanged after: total on books **₱222,827.00**, **184** ledger
rows, all-time transfer fees **₱40.00**, `chain_breaks 0`. Snapshot:
`backup-before-trf-redate-20261008.dump`.

- **The reported effect.** The Expense report's service fees for 2026-09-25 move
  **20.00 → 40.00** (5 → 7 transfers); the all-time figure stays ₱40.00, because only the day
  attribution changes. Total Income is untouched by construction — the income report carries
  `transferFees` on every row as a reference column and never adds it into `totalIncome`.
- **The register was never in scope.** None of the six ledger rows sits on a `cash` account
  (they are e-wallet and bank), so `cashExpenses` read 31,372.00 before and after.
- **Not a defect — recorded so it is not "fixed" later.** `TRF-2026-000028` reports two
  transfer-vs-ledger day disagreements. It has four ledger rows: two dated 2026-09-25 (the
  originals) and two dated 2026-10-01 reading *"Correction: Wrong input from operator. From
  20,000 to 22,000 plus service charge 10.00."* The correction was **appended on the day it
  was made** rather than overwriting the original — which is exactly the corrections-append
  rule. Grouped on first posting, all seven posting transfers agree with their
  `transfer_date`.

---

## 22. The register totals what it spent

### D27 — the total sits under the column it totals

The register listed every row that touched the drawer and no sum of them, so *"what did we
spend in cash"* meant adding the Amount column by eye. Two decisions define the figure, and
the first is the one that would have been wrong by ₱200,000.

**Direction cannot define an expense.** Of the **₱231,372.00** that left the drawer, ₱200,000
is an `owner_return` and the rest is largely customers being handed their own money. Both are
debits; neither is spending. Total the wrong set and the register reports the owner's capital
as company expense. The figure therefore sums only the three buckets where the company was the
party that paid — `operating_expenses`, `provider_charges`, `payments` (`EXPENSE_BUCKETS`) —
and only rows facing out:

```
gross outflow   231,372.00     ← what "every debit" would have printed
cash expenses    31,372.00     ← Operating Expenses + Provider Charges + Payments & Bills
```

- **It follows the filters, and it covers all of them.** Computed over the *filtered
  population*, never the page: page 1 and page 2 both read `31,372.00` while showing five
  different rows each; a search matching nothing reads `0.00`; and filtering to **Owner
  Capital** — three rows summing **₱531,827.00** — reads **`0.00`**.
- **It is placed in the Amount column's footer**, not above the table: a `<tfoot>` of
  `colSpan 7` + Amount + `colSpan 2` across the ten columns. A figure read under a column is
  read as that column's sum, which is what it is. The definition and the scope are printed
  beside it, because a total a reader cannot account for is a number they must take on trust.
- **It is pure** — `cashExpenseTotal` does no network and no database work, so the endpoint
  and its test run the same function (AGENTS.md architecture rule 1).

**It also settled the drawer.** The page warned that *Cash on hand* and *Expected now*
"differ by ₱31,372.00" — the very figure in the footer. The cash account's complete ledger:

```
seq  entry              amount      balance_after
  1  Owner funding     200,000.00   200,000.00     #254
  2  Owner return      −200,000.00        0.00     #255
  3  Owner funding     131,827.00   131,827.00     #256 — the counted float
  4–20  17 expenses    − 31,372.00   100,455.00     the footer total
```

`131,827 − 31,372 = 100,455`, and the seventeen rows sum to exactly **31,372.00**, matching
the statement's `operating_expenses: 31372, count 17`. **Nothing is missing:** the operator
counted ₱131,827 at shift open, ₱31,372 has since been paid out of it, and the books read
₱100,455. The "difference" the page displays *is* the expense total.

What remains is the drawer-window backlog: *Expected now* still prints the raw count rather
than the count net of movements, which is why the two readings differ at all. §23 closes it —
and the answer was not labelling.

---

## 23. The drawer's window reads the posting instant

### D28 — a shift's window is bounded by when a row was posted, not by the day it files under

§22 left the two readings ₱31,372 apart and called it labelling. It was not labelling. The
figure was wrong, and wrong in a way that would have closed the shift as short.

**The confusion was reasonable.** *Cash on hand* (₱100,455) and *Expected now* (₱131,827) are
meant to be two independent readings of one drawer (D16), and they disagreed by exactly the
expense total. The ledger had it right — `131,827 − 31,372 = 100,455` — so it looked as though
the expenses had come off the balance but not off the expectation. They had come off neither
display, because **the arithmetic behind them could not see them at all.** The shift was opened
on **8 October** for the **25 September** business day:

```
shift        shift_date   2026-09-25
             opened_at    2026-10-08 20:39:46 +08
cash rows    entry_date   2026-09-25        (all 20 — the business day they file under)
             created_at   2026-10-08 20:17 – 22:03   (when they were actually posted)
```

`drawerMovements` filtered `l.entry_date >= opened_at`, comparing *25 September* against
*8 October*. It returned **0 rows**, so `expectedClosing` had nothing to add and printed the
count back at itself:

```
before   movements  0    expected 131,827.00   cash on hand 100,455.00   difference 31,372.00
after    movements 17    expected 100,455.00   cash on hand 100,455.00   difference      0.00
```

**Why it mattered more than a label.** `classifyVariance` measures the counted close against
`expected`, so closing this shift while holding the ₱100,455 the drawer actually holds would
have reported **SHORT ₱31,372** — a shortage equal to every expense the shift had legitimately
paid. D16 warns about precisely this: *"a reconciliation that is always wrong is one operators
learn to ignore."*

**The window now reads `created_at`.** A shift is a physical span — the drawer opens at an
instant and cash leaves it when a row is written. `entry_date` is an accounting attribution
picked from a date field, and it need not fall inside that span at all.

**The minute-flooring had to go with it.** `drawerWindow` used to open at the start of
`opened_at`'s minute, because `entry_date` carried no seconds. Against `created_at` — stamped
by the database with sub-second precision — that widening is wrong, not merely unnecessary:
this shift opened **9.7 seconds after** the funding that set its float, so a window starting at
the top of that minute admits the funding as a movement on top of the count that already
includes it.

```
created_at, exact open    17 rows   net −31,372    expected 100,455   ✓
created_at, floored       18 rows   net +100,455   expected 232,282   ✗ the float counted twice
```

**One query, not two.** The drill-down listing the rows behind the figure carried its own copy
of the window predicate — in the very file whose header promises these are *"kept in one place
so a shift's expected figure and the report that later audits it can never drift apart"*. That
promise was false, and drift between the two is exactly this bug. The rows query moved into
`drawerQuery.ts` as `drawerMovementRows`, and `drawerMovements` is now a projection of it.
There is one SQL string defining the drawer's window, so the list and the number above it
cannot disagree.

**Transfer service fees were never part of this.** Zero ledger rows on cash accounts come from
`transfers`; the ₱40 of Sep-25 service fees comes off the source e-wallet. That is why the
shift's Expense panel reads **₱31,412** while the drawer falls **₱31,372** —
`31,372 drawer + 40 off-drawer`.

**What it did not touch.** A read path only: no balance, no transaction and no shift row was
written. The two closed shifts are unaffected — their windows contain no postings either way,
and both still read `expected = counted, variance 0`.

| | before | after |
|---|---:|---:|
| *Expected now* | 131,827.00 | **100,455.00** |
| Cash on hand | 100,455.00 | 100,455.00 |
| difference | 31,372.00 | **0** |
| cash-out during the shift | 0.00 | **31,372.00** |
| rows in the drill-down | 0 | **17** |
| shift report `totalCashOut` | 0.00 | **31,372.00** |

---

## 24. One number, two names

### D29 — the drawer is identified by its type, and named by the card that totals it

*Cash on hand* and *Revolving Fund* read as two pots holding the same peso, and the question
that follows — which of them is real, and which is a copy? — is exactly the right question to
ask of a money screen. Neither is a copy, and neither can be removed.

They are two different things:

| | what it is |
|---|---|
| **Revolving Fund** | one account — a row with `current_balance`, a twenty-row ledger chain, a statement, an audit trail |
| **Cash on hand** | `SUM(current_balance)` over **every** cash-type account on the branch |

They print the same figure only because each branch holds exactly one cash account today.
The drawer is keyed on the *type* rather than on one named account precisely so that a
branch's physical cash may be split across two (`drawerQuery.ts`) — the aggregate exists so
it can be, and the account exists because the ledger needs a row to post to.

**Deleting the account would not merge the two figures. It would delete the money.**

```
TOTAL ON THE BOOKS   222,827.00
ACCOUNTS (NON-CASH)  122,372.00   ← everything that would remain
```

₱100,455 leaves the books, twenty ledger rows orphan, the balance-after chain breaks, and
`resolveDrawerLeg` starts refusing every cash movement with *"this branch has no cash account
to take the money from."*

So the work is in the two places the confusion actually lives.

**The card names what it totals.** `/cash-management/statement` returns `drawerAccounts`
beside `drawer`, and the note under the figure reads *"Revolving Fund — in the branch
drawers, already counted in the total."* One number, one name, said out loud. It falls back
to the bare note when the server sends nothing, because a label that explains nothing is
better than one that names the wrong account — the server is the only place that knows which
accounts are cash.

**Nothing finds the drawer by its name any more.** `'Revolving Fund'` was string-matched in
two runtime places: the expense form's preselected account, and the drawer leg in
`resolveDrawerLeg`. Both now match `account_types.code = 'cash'`, which is what every other
drawer query already did. The risk was live rather than theoretical — rename the account and
the default would have quietly emptied while the account went on holding the money.

Migration 034 keeps its copy of the name and is deliberately left alone. There the string is
a seed label and the idempotency guard for that same seed row, not a lookup anything depends
on; and it has been applied, so rewriting it would desynchronise `_migrations` from the files
on disk.

**What the drawer contains, and why it is only two things.** All twenty of its rows are owner
capital and operating expenses. `cash_in` and `cash_out` contribute nothing, because all 108
of them carry `payment_method = NULL` and `touchesDrawer` is true only for `cash`. That rule
arrived in migration 036, after the rows were written. Forward of this, the form refuses a
cash movement without a method, so new rows do reach the drawer — but only when money was
physically handed over, which is the point: a GCash or bank movement landing in a wallet
never passed through the drawer, and giving it a leg would count the same peso twice.

---

## 25. A count that cannot be gamed, and a discrepancy that cannot be silent

Three of the four things §14 promised were missing in practice. None of them move money;
every one of them writes a count or a fact about a count (D14 holds throughout).

### D30 — the close is two steps, and the first one knows nothing

The close dialog showed **Expected closing**, **Cash in since**, **Cash out since** and
**Drawer on the books** above the count field, and computed **Difference** the moment a digit
was typed. The exploit needed no malice: enter `0`, read the target, enter the target. A count
whose answer is on screen before the count is taken is not a control, and nothing in this
document had ever discussed it.

It is now two steps:

| | shows | does |
|---|---|---|
| **Count** | the denomination grid and the total. Nothing else | counts |
| **Review** | opening, cash in, cash out, expected, difference, drawer on the books | compares, requires a reason, closes |

Opening float and the two movement figures go too, not only the expected line — the three of
them *are* the expected figure, so leaving them would be the same leak wearing a different
label.

**"Check the count" is one-way.** It writes the count in and reveals the reconciliation in the
same instant, and there is no Back, because Back is the loophole. Cancel still exists; it
abandons the close entirely rather than returning to an edited count.

The tally sheet replaced the pre-count print for the same reason. The count sheet carries
Expected closing and was printed *before* the count, which handed the answer over on paper as
readily as on screen. `TallySheet` — denomination rows, quantity, subtotal, signatures, and no
financial figure anywhere — is what the counting step prints now.

**Stated limitation.** `live.expected` is still in `GET /cash-management/shifts` and the
*Expected Now* card still shows it, so somebody determined can read the answer before they
begin. Closing that would mean withholding the figure the page exists to display and D16
requires for its cross-check. What this removes is the ritual handing you the answer while
you are counting, which is the anchoring the count was always meant to prevent.

**The count is a tally.** Ten denominations — 1000, 500, 200, 100, 50, 20, 10, 5, 1, 0.25 —
entered as quantities and summed in **centavos**, because one of them is ₱0.25 and has no exact
binary float. A tally that drifts by a fraction of a centavo cannot be reconciled against a
count that does not, and a mismatch the operator cannot explain is how a control becomes
noise.

| | |
|---|---|
| grid entered | the total is derived and the field becomes read-only — the grid *is* the count |
| grid left empty | the total is typed, as before |
| either way | the pair is checked server-side: `The denominations add to 500.00, which is 50.00 short of the 550.00 declared` |
| stored in | `shifts.count_detail` (jsonb), only the quantities actually entered |

An empty grid stores nothing rather than a row of zeros, so a hand-typed total leaves behind
no claim that it was tallied. The vocabulary rides on `GET /cash-management/shifts` instead of
being copied into the client: a reason list the server would refuse is worse than no list at
all, and one kept in two places is one kept badly.

### D31 — a shift that differs must say why, in words a report can count

D14 says a discrepancy is *an event needing investigation, not a balance to be adjusted
away*. `notes` was optional, so a shift could close ₱5,000 short with nothing written, and the
investigation left no trace anybody could find.

`variance_reason` now fills from a closed list: **recounted**, **a movement was never
recorded**, **cash left the drawer without a record**, **change or tender handled outside the
system**, or **other** — and *other* is accepted only alongside notes, so the catch-all still
has to say something. A closed list rather than free text because the answer is worth
counting: five shifts short under five different labels is a pattern, and free text never
aggregates.

**The rule is a database constraint, not a route check.** Migration 040 adds

```sql
CHECK (status = 'open' OR variance = 0 OR variance_reason IS NOT NULL)
```

A rule that lives only in application code is one refactor away from being unenforced, and
this is the rule the whole design rests on. Both shifts closed to date balanced exactly, so
no existing row is invalidated.

A balanced shift stores no reason. A reason beside a zero variance would read as an incident
nobody had.

### D32 — a variance stays on the list until somebody has answered for it

D14 promised an investigation. Nothing carried one forward: a shortage recorded at close
disappeared the moment the next shift opened, which is the same as never having been
recorded at all.

`variance_resolved_at` / `variance_resolved_by` close the loop, and the Cash Management page
lists every closed shift with a non-zero variance that carries neither. Each entry shows the
branch and day, expected against counted, who closed it, the reason and the notes — and an
administrator marks it investigated.

**These are the only columns here written after the shift locks**, deliberately. An enquiry
into a shortage is a fact about the enquiry, not a correction of the count: `counted_closing`,
`expected_closing` and `variance` are untouched by it, and no balance and no ledger row is
involved. The database holds that apart — resolution is accepted only for a closed shift that
actually differed, and the two resolution columns are set together or not at all, so a
variance cannot look answered while its author is missing.

**Administrator-only**, for the reason a reconciliation adjustment is: the shortage happened
under whoever closed the shift, and they are not the person who gets to say it has been dealt
with.

What still does not happen, on purpose: nothing writes off the amount. A resolved variance is
a shortage somebody has explained, not a shortage that stopped existing.

---

## 26. Two doors the entry form does not have

The transaction form is driven by fee rules and carries no free type picker, which made both
of these reachable only by hand-crafting a request. Neither is reachable from the browser.

### D33 — a cash account can only have been paid by cash

§17 raised this for expenses. It turns out to be the account's rule rather than the type's, so
it is applied to every transaction on a cash-typed account.

A cash account's balance *is* the drawer's physical cash. Crediting one means cash walked in
and debiting one means it walked out, so `gcash` against it describes a wallet movement the
drawer never saw — and the shift then closes short against money nobody counted. The field was
free text among five options, with nothing tying it to the account behind it.

**A blank is filled in, a method that disagrees is refused.** The account answers the question,
so asking again only produces a 400 where the books already know. Refusing rather than
overwriting a wrong method matters for the opposite reason: a quiet overwrite would record
something the operator did not choose, and they would never learn the rule existed.

**Nothing needed backfilling, which is why this was safe to ship.** Measured before the change:
all 20 transactions already on cash accounts carry `cash`, and every one of the 4 non-cash
methods sits on a bank or e-wallet account. The rule was already the practice; it just was not
enforced. It is now enforced on creation and on edit, because an administrator editing a
pending row's method is the other way to write the same lie.

### D34 — the Expense row belongs to the system

`expense` is the row the provider-charge path writes beside a cash movement, linked back
through `linked_transaction_id` (migration 032). Typed in by hand it posts a debit with no
recipient and describes no movement.

The sharper problem was the queue. Only owner fund movements and operating expenses route
through approval, so a hand-typed `expense` would have settled **immediately** — spending
company money with no second signature, which is exactly what the queue exists to prevent. A
cost the company chose to pay is an operating expense; a charge the provider made and never
billed the customer is not something anyone chose, and is what this type means.

**A fee is refused on the same row.** A fee is income, and this row is a cost: booking one
would report the company as having earned from an expense. No fee rule has ever targeted the
type, so the refusal closes a door nothing was using.

**§9's question — is this path in use?** It is not dead code and it is not live either. It has
never run, because no operator has ever keyed in a provider charge: 0 rows anywhere in the
database carry a `linked_transaction_id`. The path is wired and correctly bucketed; it is
waiting for the first charge, not waiting to be deleted.

---

## 27. Gross, and labelled as gross

§17's first new question asked whether `Σ account balances` still means anything once both
legs post, and whether Sources and Uses should report gross movement or be netted.

**Measured first, because the question assumed a state that had not happened.** The
counterparty leg has never posted: 149 transactions, 149 ledger rows, one each. And 0 of the
108 cash movements carry `payment_method` at all, so none of them can ever take one — D11
stands, history is never backfilled. Those 149 rows add up to Sources of ₱482,456 and Uses of
₱383,231, one row apiece with no second leg anywhere, and that is the only slice a second leg
could ever appear in — so it is not inflated today, and never will be on existing data.

**The inflation starts with the first cash-settled movement booked from now on.** At that
point a ₱500 cash-in with a ₱10 fee writes two rows: Sources +500, Uses +490, net +10 — the
fee, exactly what the income report books. The tie-out holds either way, which is why this was
a reporting question and not a correctness one.

**Gross is the honest reading, so it is kept.** Both rows describe something that really
happened: the wallet really was credited ₱500 and the drawer really did hand over ₱490. What
was missing is the label. Sources now says on its face that it counts movement in full rather
than netting it, and names the pair — so it cannot be read as "new company money in". Uses
says the same from the other side.

**What was deliberately not built:** a netting view, and a leg discriminator.
`ledger_entries` has no column distinguishing the account leg from the drawer leg — only
`transaction_id` links the pair — so bucketing the internal leg separately would have been a
schema change to solve a presentation problem. The label does the same job for nothing.
