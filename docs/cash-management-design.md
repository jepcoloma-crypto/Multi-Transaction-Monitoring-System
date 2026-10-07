# Cash Management Module — Design

Status: **Phases A–E implemented and deployed** (migrations 034/035 applied to production,
engine, endpoints, Cash Management page, Expense report component — commits `b3d8faf`,
`3a5005e`, `8a0f176`).

Sections 10 onward — drawer participation, shifts, and the open-shift precondition of §18 —
are **written and implemented but not deployed**. Nothing is pushed: the authoritative list
of what is pending is `git log origin/main..HEAD`. Migrations 036 and 037 are written but
**not applied**. The order they go live in is forced, not preferred:

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

Without this, `drawer_delta = wallet_delta + fee` cannot hold for cash-outs.

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

1. **Headline split** — `Cash on hand now ₱122,372` is renamed to *Total funds on the
   books*; the drawer gets its own figure: *Cash in branch*. The two are never summed.
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
| 5 | `expense` provider-charge path, 0 rows | **Still open** — worth a separate look; it also has no fee-rule guard. |

New, carried into implementation:

1. **Is `Σ account balances` still a meaningful figure once both legs post?** The accounts
   were confirmed company-owned in §1. Posting both legs makes the statement report *gross*
   movement rather than net, which is correct for *"where did cash move"* but inflates
   Sources and Uses. **Accept, and label the headline accordingly** — or, if the figure is
   meant to be net company funds, the statement needs a netting view. Flagged rather than
   assumed: the tie-out holds either way, so this is a reporting question, not a
   correctness one.
2. **`payment_method` on operating expenses** — an expense paid from the drawer is
   physical by definition. Confirm it should be forced to `cash` when the account is
   `cash`-typed, rather than left to the operator.

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
