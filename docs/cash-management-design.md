# Cash Management Module — Design

Status: **proposed, not implemented.** No code in this document has been written.

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
