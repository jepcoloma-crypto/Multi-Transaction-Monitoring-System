# System Gaps — Assessment and Plan

**Date:** 2026-10-17
**Scope:** Verified gaps in the monitoring system, with a recommended order of work.
**Status:** Proposal — nothing here is built yet.

This was produced by reading the code and the live database, not by listing
generic best practices. Every claim below was checked; where I could not verify
something, it says so explicitly.

---

## What was checked and found sound

Recorded so the gaps below are read in proportion. These were suspected as
weak and are not:

| Area | Finding |
|---|---|
| Shift variance | `classifyVariance`, required reasons, admin-only resolution, separate opening/closing variance handling. Thorough. |
| Reconciliation | Balance reconciliation, bank-statement matching with auto-match, and gap fixes all exist and are in the nav. |
| Audit trail | Audit Logs and Fee Audit pages exist; corrections write proper before/after trails. |
| Transfer references | Minted as `TRF-YYYY-NNNNNN` and immutable. Cannot collide from operator input. |

---

## Gap 1 — Alerts are in the nav but can never fire

**Severity: high. This is the only gap that actively misleads an operator today.**

`generateAlerts()` in `backend/src/services/alerts.ts` is fully written and
detects five real conditions:

1. Balance at or below the account's `minimum_balance`
2. Balance at or below the critical threshold
3. Transfers pending longer than `pending_transfer_alert_hours`
4. Transactions at or above `large_transaction_threshold`
5. Accounts not reconciled within `reconciliation_period_days`

The thresholds already exist in `system_settings` and are editable in the UI:

```
critical_balance_threshold   = 100
low_balance_threshold        = 1000
large_transaction_threshold  = 50000
pending_transfer_alert_hours = 24
reconciliation_period_days   = 30
```

**The problem:** `generateAlerts()` is reachable only by manually POSTing to
`/alerts/generate`. There is no cron, no `setInterval`, no scheduler anywhere
in the backend. The `alerts` table has **0 rows**.

An operator opens **Alerts**, sees an empty page, and reasonably concludes
nothing is wrong. It actually means alerts have never run. The screen reports
false confidence — which is worse than not having the feature, because a
missing feature gets worked around and a broken one gets trusted.

This is also the most likely reason the GCash→Maya transfer went unrecorded:
nothing was watching for it.

### What the fix involves

- A scheduler hook in `startServer()` (`backend/src/index.ts:83`), which is
  already an async function and is the natural home for it.
- Run once shortly after startup, then on an interval.
- pm2 runs a **single instance** (`ecosystem.config.js`, no `instances` key,
  no cluster mode), so an in-process `setInterval` cannot double-fire. Worth a
  comment in the code so nobody adds `instances: 'max'` later without also
  moving this to a table lock.

### Bugs to fix inside `generateAlerts()` while I am in there

Both found while reading it, both worth fixing as part of this work:

- **SQL built by string interpolation** at `alerts.ts:66` and `alerts.ts:128`:
  `INTERVAL '${pendingHours} hours'`. The value comes from `system_settings`,
  so it is not directly attacker-controlled, but a non-numeric setting value
  would produce broken SQL rather than a clean error. Should be a parameter.
- **N+1 queries**: one `SELECT` per account to check for an existing unread
  alert, then one `INSERT`. Fine at 12 MB, but the dedup can be a single
  `NOT EXISTS` in the selecting query.

### Effort and risk

Small. The logic is written and tested by observation; this is wiring plus two
local fixes. Risk is low and contained — the worst case is too many alerts, and
the existing per-entity dedup already prevents repeats.

**Verification:** after wiring, the table should fill with real findings on the
first run. I would show you the generated alerts before considering it done.

---

## Gap 2 — Duplicate reference numbers are accepted

**Severity: medium-high. Most likely real-world data error.**

`transactions.reference_number` has only a non-unique btree index
(`idx_transactions_reference`), and the create handler writes it with no
existence check. Re-entering the same GCash reference — a double-click, a
retry after a timeout, a duplicated receipt — books the transaction twice.

### The constraint that changes the design

I checked all existing data. There are exactly two repeated references in
production:

```
36855 → TX #41 (reversed) + TX #131 (completed)   Paula Bayubay,  ₱4,116.00
68975 → TX #82 (reversed) + TX #119 (completed)   Jed Bautista,   ₱1,820.00
```

**Both are legitimate reversal-and-re-enter pairs, not errors.** The reversal
workflow deliberately reuses the reference so the pair stays recognisable.

So a plain `UNIQUE(reference_number)` index would **break a working workflow** —
it would refuse the re-entry that completes a reversal. This is exactly the
case that makes a naive fix wrong.

Two things make the correct rule expressable:

- The superseded row is always `status = 'reversed'`.
- Reversal pairs here carry **no** `linked_transaction_id` — it is NULL on all
  four rows above. So the check cannot lean on the link column.

**Proposed rule:** refuse a reference only when another transaction with that
reference exists *and is not reversed*. Reversal re-entry stays possible.

This is a business-rule check in the handler, not a database constraint — a
partial unique index on `WHERE status <> 'reversed'` would also work and would
be stronger. I would want your call on which, since the constraint version
catches races the handler check does not.

### Note: transfers are already safe

Transfers mint `TRF-YYYY-NNNNNN` immutably. Only operator-typed references are
at risk, which narrows this to the Cash Transactions form.

### Effort and risk

Small for the handler check; slightly more for the partial index because the
existing duplicate pairs must be confirmed to satisfy it first (they do, since
one side of each is reversed).

---

## Gap 3 — Backups are manual and stored beside the data they protect

**Severity: medium. Low likelihood, highest cost if it happens.**

There is no scheduler for backups either. All 38 files in `backups/` were taken
by hand — most named `backup-before-<some-risky-operation>`, which is good
discipline for migrations.

But they live at `C:\Projects\...\backups`, on the **same disk** as the live
database. A disk failure, a ransomware event, or a botched `DROP` takes the
data and every backup of it together.

The saving grace: the database is **12 MB**. A `pg_dump` takes well under a
second. Cost is almost entirely configuration, not capacity.

### What the fix involves

- Nightly scheduled dump, reusing the existing `pg_dump` invocation in
  `routes/backup.ts:53` rather than writing a second one.
- Retention, so the folder does not grow without bound.
- **Copying off this machine.** This is the part that actually matters — a
  second disk is not a backup. Options in rough order of simplicity: a cloud
  bucket with credentials, a second machine, or a network share.

I cannot pick the destination for you — it depends on what accounts and
machines you have access to, and it involves handing the system credentials
for somewhere off this host.

### Worth verifying before building

Whether Postgres has its own archiving configured, which would make an
application-level scheduler redundant. I have not checked this.

---

## Gap 4 — Money arrives as strings, and is patched one feature at a time

**Severity: medium. A recurring bug class rather than a single bug.**

No `pg.types.setTypeParser` is installed, so every `numeric` column reaches
the backend as a string. Each new feature has to remember this independently.

I have hit it **four times** today alone:

- `AccountSelect` — a `typeof === 'number'` guard that could never fire, so balances rendered as absent. Shipped and fixed as `9e090cc`.
- `ProductSelect` — built today; had to type `selling_price` as `number | string` to survive.
- Both needed the same `balanceOf`/`priceOf`-style parser written twice.
- The pattern is latent in every other money display in the frontend.

### Why this is last, not first

Installing the parser is a **one-line change with a wide blast radius**. It
silently alters the runtime type of every numeric value in the backend, and
code that currently relies on string behaviour — `.toFixed()` calls, string
concatenation, loose comparisons — would change meaning. `reports.ts` alone has
dozens of `.toFixed(2)` calls whose inputs would change type.

So this is an audit, not a patch: install the parser, then run the full 516-test
backend suite and read every failure as a genuine finding rather than papering
over it. Done properly it removes the class; done hastily it converts a known
quirk into an unknown one.

I would rather do this deliberately than fold it into something else.

---

## Recommended order

| # | Gap | Why this position | Effort |
|---|---|---|---|
| 1 | Alerts never fire | Only gap actively misleading operators. Logic already written. | Small |
| 2 | Duplicate references | Most likely real error. Design constrained by real data, now understood. | Small |
| 3 | Off-machine backups | Cheap here (12 MB). Needs your decision on destination. | Small + a decision |
| 4 | Numeric-as-string | Widest blast radius. Do it deliberately, last, with the full suite. | Medium (audit) |

1 and 2 are independent and could be done in either order. 3 is blocked on a
decision only you can make. 4 is best done when nothing else is in flight.

---

## The theme underneath

The system is excellent at recording **what happened** and has no mechanism for
surfacing **what should have happened but has not**. The unrecorded ₱12,830
transfer, the ₱10 owner payable, the shift still open since 13 October, and the
alerts that never fire are all the same shape of gap.

None are bugs. They are things the system has no way to remind you about, so
they currently live in a spreadsheet and this conversation instead of in the
software.

Fixing alerts addresses the first instance of this. If the pattern keeps
showing up after that, a "pending / expected" register would be the structural
answer — but I would want to see whether alerts alone close the gap before
proposing more.
