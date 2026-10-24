# System Audit — Consolidated Assessment

**Date:** 2026-10-23
**Scope:** Whole-system audit of the monitoring system — backend (Express/TS + PostgreSQL), frontend (React/TS), database schema (50 migrations), deployment and operations.
**Method:** Five parallel read-only deep-dives (security, database/integrity, backend architecture, frontend, testing/operations), each citing file:line evidence, plus direct verification of deployment config and git hygiene. Both test suites were executed: backend 640/640, frontend 143/143.
**Status:** Assessment only — nothing in this document is built or changed yet.

Companion doc: `docs/system-gaps-plan.md` (2026-10-17) remains the source for the four gaps it identified; their current status is tracked at the end of this document.

---

## What was checked and found sound

Recorded so the gaps below are read in proportion. These were suspected as weak and are not:

| Area | Finding |
|---|---|
| Money schema | Every monetary column is `NUMERIC(15,2)` — no FLOAT/DOUBLE anywhere in the schema. |
| RBAC / branch scoping | `scope.ts` / `shiftGate.ts`: parameterized SQL everywhere, allowlisted table names in corrections, branch filters ANDed into row scope, 404-instead-of-403 existence protection. Unusually well-built. |
| Write transactionality | All primary money paths (transaction create, transfer create/approve/delete, loading, corrections, gap-fix, import) wrap in `BEGIN/COMMIT/ROLLBACK` on a dedicated client with row locks in sorted-id order to avoid deadlocks. |
| Time module | `manilaTime.ts` is internally meticulous (rejects impossible dates, returns bounds as one unit); the flaw is that its Asia/Manila assumption is never enforced on the DB session (see C4). |
| Fee engine | `feeCalc.ts`/`movementFee.ts` are consistent with the frontend (the preview calls the same resolution path); whole-peso fee ceiling is intentional and documented. |
| Git hygiene | `.env` is gitignored; no real secrets tracked (only example files). |
| Rate limiting in the tunnel topology | `trust proxy: 'loopback'` correctly keys per-caller for the Cloudflare-tunnel deployment; auth and shift-override-verify limited to 20/15min. |

---

## 🔴 Critical

### C1. Backup endpoints: path traversal → arbitrary file read/delete/psql execution
`routes/backup.ts:215-224` (`GET /download/:filename`), `:194-213` (`DELETE /:filename`), `:75-103` (`POST /restore`) join `path.join(BACKUP_DIR, req.params.filename)` without confining the result. Express decodes `%2F`, so `..%2F..%2F.env` resolves outside `BACKUP_DIR`:
- `download` streams any file the process user can read (`.env` with DB/JWT secrets, the entire backup set) to a `settings.read` holder.
- `delete` `unlinkSync`s arbitrary files for a `settings.write` holder.
- `restore` feeds attacker-chosen SQL files into `psql -f`, and can restore old DB states.

Additionally, `/restore` is **not transactional** (`psql -f`, no `--single-transaction`), has **no production guard** (compare `/clean`, which refuses in production at `:137-142`), and takes **no pre-restore safety dump**. A mid-file failure leaves a partially restored database with no rollback.

**Fix:** whitelist `filename` against `/^[A-Za-z0-9._-]+$/` (or `path.basename` + `path.resolve(...).startsWith(BACKUP_DIR)`) on all three endpoints; require `NODE_ENV !== 'production'` or a two-person confirmation for restore; run restore with `--single-transaction`; dump before restoring.

### C2. Import endpoints bypass branch scoping, the shift gate, and amount validation
Every other money-movement route enforces `assertBranch` + `assertOpenShift` (`transactions.ts:486/531`, `transfers.ts:180/187`, `loading.ts:167/172`). The bulk-import routes enforce **neither**:
- `routes/import.ts:34-126` (`/import/transactions`): account id from the row/body, no branch check, no open-shift check — an operator of branch A can post completed transactions that debit/credit any account in any branch, including closed shifts (shift-gate D17 is dead on this path).
- `routes/import.ts:194-327` (`/import/loading`): same two omissions; writes drawer legs (money movement) with no gate.
- **Negative/NaN/infinite amounts:** `parseFloat(row.fee || '0')` with no `Number.isFinite`/sign check — the single-entry path rejects both via `validateMovementInputs` (`movementPlan.ts:117-122`). With `direction='out'`, `newBalance -= amount + fee` and `fee = -5000` *increases* the balance.
- **Wrong `net_amount`:** hardcoded `net_amount = amount` while the balance moves by `amount + fee` — imported rows disagree with the ledger/balance, corrupting fee reports and the fee-audit tooling.

**Fix:** per-row `assertBranch` + `assertOpenShift`; apply `validateMovementInputs(amount, fee)`; compute `net_amount` with the same arithmetic as the single-entry path; cap rows per import; surface a warning when any row fails instead of silently committing the successes.

### C3. Known/fallback production secrets
- `docker-compose.yml:38` — `JWT_SECRET: change-me-in-production`; `:13/:37` — `POSTGRES_PASSWORD: postgres`; Postgres 5432 published to the host.
- `config/index.ts:17` — `JWT_SECRET || 'dev-jwt-secret'`; `:14` — `DB_PASSWORD || 'postgres'`. If the env var is unset in production the server silently runs on a **well-known secret**; there is no `NODE_ENV === 'production'` guard.
- `database/seeds/001_initial_users.sql:2-3` — both `admin` and `operator` share one committed bcrypt hash, computationally verified to be the plaintext **`password`**; `admin` is granted the full permission set (`001_initial_schema.sql:94-97`).

Anyone who can read the repo (or guess the strings) can sign JWTs for any user with any roles — the JWT carries `roles`/`permissions` (`auth.ts:76-90`) and `authorize()` trusts them. Full authentication bypass with administrator privileges.

**Fix:** fail fast at startup when `NODE_ENV=production` and `JWT_SECRET` is missing/short/known-default; rotate the secret if it ever ran on a default; never seed a real role with a published hash (random per-deployment password printed once, or env-provided); stop publishing Postgres to the host.

### C4. DB session timezone is never pinned — every report/statement window silently shifts +8h
`manilaTime.ts` is internally correct but its Asia/Manila assumption is **unenforced**: nothing sets the PostgreSQL session timezone (no `SET TIME ZONE`, no `PGTZ`, no pool `options`; the docker DB defaults to UTC). 32 inline `::date + INTERVAL '1 day'` end-of-day bounds (`reports.ts` ×24, `transactions.ts` ×2, `transfers.ts:66`, `loading.ts:116`, `auditLogs.ts:43`, `cashManagement.ts:237,241`) assume a Manila session. Under a UTC session every window is `>= start-day 08:00` to `< end-day+1 08:00` — the first 8 hours of the start day are excluded and the first 8 hours after the end are included. Reports, statements, audit logs and the shift gate (`shiftGate.ts:128-130`) can silently disagree about which day a peso belongs to.

**Fix:** set `options: '-c timezone=Asia/Manila'` in the pool config (`connection.ts`), or make `entryDateBounds` compute the bound with `AT TIME ZONE 'Asia/Manila'`; replace the 31 inline copies with `entryDateBounds`; add a test asserting the bound instants.

### C5. Migration tooling is broken
- **Rollback always fails:** `database/migrate.ts:67` stores migration names without `.sql`, and `rollbackMigration` (`:91-93`) rebuilds the path without the extension → `ENOENT` on every `migrate rollback`. All `-- Migration:down` sections (maintained across ~40 files) are unreachable dead code. `:125-126` exits 1.
- **030/031/032 break transaction atomicity:** they open their own `BEGIN; ... COMMIT;` inside the runner's `BEGIN/COMMIT` (`migrate.ts:65-68`). The inner `COMMIT` closes the runner's transaction; everything after it (including the `INSERT INTO _migrations`) runs in autocommit. A mid-migration failure leaves half-applied schema/data **committed** while `_migrations` says it never ran — and re-running fails on the already-applied parts. Migration 033's own comment (`033_branches.sql:34-38`) names this exact hazard, then 030-032 do it.

**Fix:** `path.join(MIGRATIONS_DIR, `${lastMigration}.sql`)`; strip `BEGIN/COMMIT` from 030/031/032 (the runner already provides the transaction), or teach the runner to detect and refuse embedded transactions.

### C6. No CI/CD of any kind
No `.github/`, no workflow — nothing runs lint/test/build on push; every change lands on production untested by machine. Both Dockerfiles are **broken as committed**: `npm install --omit=dev` then `npm run build`, but the build needs `typescript` (+ `vite`) which are devDependencies → the image build fails (`Dockerfile:5-7`, `Dockerfile.frontend:7-10`). No `.dockerignore` (host `node_modules` is dragged into the image); both run as root.

**Fix:** a GitHub Actions (or equivalent) workflow running `npm ci && npm run lint && npm test && npm run build` on PR + push-to-main, gating deploys; fix the Dockerfiles (full install in a builder stage, add `.dockerignore`, `USER node`).

---

## 🟠 High

### Security & access
- **H-SEC-1. Deactivated users keep valid sessions.** `authenticate` (`middleware/auth.ts:35-47`) checks signature + blacklist + live `user_branches`, but never re-reads `users.is_active` or roles (which ride in the JWT for up to 24h). `/refresh` (`auth.ts:163-189`) re-reads roles but not `is_active` — a deactivated user can refresh forever. **Fix:** check `is_active` on every authenticated request and at refresh.
- **H-SEC-2. Refresh-token lifecycle is broken and unused.** Refresh tokens are JWTs with the same payload/secret as access tokens (`auth.ts:88-90`), no `jti`, no rotation, no reuse detection; logout blacklists only the access token; and the **frontend never calls `/auth/refresh`** (`AuthContext.tsx:76-78` stores it, nothing reads it). The 7-day stored credential survives logout; sessions die at 24h with the UI showing "authenticated". **Fix:** rotate + reuse detection + revoke at logout; wire a single-flight 401→refresh→retry in the client, or stop issuing it.
- **H-SEC-3. `/api/search` leaks the user directory.** `routes/search.ts:9-83` has no `authorize()`; the users block (`:71-76`) is unscoped — any operator can enumerate every user's id/email/name. Accounts/transactions/transfers/loading are branch-scoped; users are not. **Fix:** gate behind `users.read` or scope to the caller's branch.
- **H-SEC-4. Rate limiting collapses to one shared bucket behind nginx/docker.** `trust proxy: 'loopback'` is correct for the tunnel deployment but wrong for the compose topology (`nginx.conf` + `docker-compose.yml`): nginx's connection is not loopback, so `req.ip` is the nginx container IP for every caller → the 20/15min login limiter becomes a single global bucket (login DoS) and audit `ip_address` values are wrong. **Fix:** configure `trust proxy` per topology; key login limiting per username+IP; add a per-IP limit in nginx.
- **H-SEC-5. CORS reflects any origin with credentials.** With `CORS_ORIGIN=*` in production, `index.ts:36-46` sets `origin: true` + `credentials: true`. Not exploitable with bearer-header auth today, but one cookie adoption away from full CSRF, and it aids cross-origin exfiltration by an XSS token-holder. **Fix:** explicit origin allowlist; never `*` with credentials.
- **H-SEC-6. Weak/inconsistent password policy + login oracle.** Admin requires ≥8 chars (`users.ts:138`); self-service requires only 6 (`profile.ts:84`). Deactivated accounts get `403 'Account is deactivated'` vs `401` for everything else (`auth.ts:32-34`) — an account-state oracle. Login limiting is per-IP only; no per-username throttle, no lockout/backoff. **Fix:** one policy, one generic error, per-username+IP limiting.

### Data integrity & money
- **H-DB-1. `pending_reversals` is an integrity hole.** No FKs on `entity_id`/`account_id` (comments claim FKs that don't exist), no status CHECK, `NUMERIC(12,2)` breaking the `(15,2)` convention (`023_delete_permissions_and_reverse_approval.sql:41-53`). Reversal requests — the approval path that moves money — can reference nothing, carry invalid states, or orphan on account deletion. DDL fix captured in the audit session; include a `status CHECK`, non-negative amount, `account_id`/`requested_by` FKs with `ON DELETE RESTRICT`.
- **H-DB-2. Account deletion can silently cascade-destroy statements and history.** The usage guard (`accounts.ts:470-484`) counts transactions/transfers/loading/ledger/reconciliations but **not** `bank_statements` (`010:5`) and `account_balance_history` (`003:55`), both `ON DELETE CASCADE`; `gap_fixes` (`029:42`) and `pending_reversals` produce raw FK 500s or orphans. **Fix:** extend the guard, wrap in a transaction, or make the two cascade tables `ON DELETE RESTRICT` with an explicit archival flow.
- **H-DB-3. Money math in JS floats; JS and DB rounding disagree.** `Math.round` rounds half toward +∞ while Postgres `numeric` rounds half away from zero — on any exactly-`.xx5` negative figure the stored and DB-rounded values differ by a centavo; `connection.ts:22` flattens every `numeric` to float64 at the driver, so DB-exact values pass through JS re-rounding on the way back. `loading.ts:189-193` stores raw-float totals that can disagree with its own centavo-computed ledger legs (`loadingPosting.ts:74-97`) — phantom gaps in the integrity checks. **Fix:** one `round2` in one `money.ts` module; centavo integers for multiply/divide; have `loading.ts` store the same `legs` values it posts.
- **H-DB-4. Integrity surface leaves transfer/loading/shift/borrowing invariants unverified.** `ledgerAudit.ts` + `integrityChecks.ts` verify per-account chains and transactions-only `net_amount`; nothing checks transfer double-entry, loading legs vs cost, closed-shift expected-vs-actual, borrowings over-repayment, or statement-vs-ledger. **Fix:** add transfer double-entry and loading-leg consistency checks in the `integrityChecks` style, plus a shift cross-check.
- **H-ARCH-1. Untransactioned multi-write bank-reconciliation operations.** Manual-match/auto-match/unmatch (`bankReconciliation.ts:108-191`) interleave `INSERT statement_matches` and `UPDATE bank_statements` with no transaction — a failure between leaves permanently inconsistent matching state. **Fix:** wrap in `withTransaction`.
- **H-ARCH-2. Audit logs written after COMMIT.** `createAuditLog` runs after commit on create/transfer/loading paths (`transfers.ts:217-220`, `transactions.ts:682-695`, `loading.ts:270-273`) — a crash between commit and insert leaves money moved with no trail. Corrections do it correctly (`auditInside` inside the transaction). **Fix:** move audit writes inside the transaction.
- **H-OPS-1. Transfer approve/reject TOCTOU race.** `transfers.ts:287` reads without `FOR UPDATE`, and the reject `UPDATE ... WHERE id = $3` (`:293-296`) has no `status='pending'` guard — concurrent approve+reject can move funds with status `rejected`. **Fix:** `SELECT ... FOR UPDATE` + `UPDATE ... WHERE id=$1 AND status='pending'` with `rowCount === 1` verification.

### Frontend & UX
- **H-FE-1. No 401/session-expiry handling anywhere.** `request()` (`lib/api.ts:44-48`) has no 401 branch; the refresh token is stored but never used; `ProtectedRoute` only checks at render. Mid-session expiry surfaces as raw `alert`s or silence. **Fix:** single-flight 401→refresh→retry; on failure, global "session expired" redirect to login with a reason.
- **H-FE-2. Load failures render as empty states.** `catch { console.error }` / `catch {}` then the empty-state branch is the dominant pattern (AuditLogs, Transactions, Backup, Charts, GlobalSearch, FundTransfers, CashManagement). A server failure reads as a clean/empty list — for audit trails and transactions this is compliance-adjacent. **Fix:** per-list `error` + Retry; `Promise.allSettled`; never `catch {}` as the terminal state.
- **H-FE-3. 100+ native `alert/confirm/prompt`; one-click `confirm()` guards DB restore.** Most serious: `Backup.tsx:39-46` — a single `confirm()` stands between an operator and a full database overwrite, while Settings already has the correct typed-confirmation pattern (`Settings.tsx:120-141`). `prompt`-based flows (notes, reversal reasons) are broken in modern browsers. **Fix:** Toast + ConfirmDialog; typed restore confirmation (word or filename).
- **H-FE-4. ImportData template download is genuinely broken.** `ImportData.tsx:52-54` reads `localStorage.getItem('token')` (always `null`) → sends `Authorization: Bearer null` → every template download 401s, silently. **Fix:** use the `accessToken` key via a shared auth-header helper; surface the error.
- **H-FE-5. No code splitting, no data layer.** All ~30 pages eagerly imported (`App.tsx:4-31`; whole app incl. recharts on first paint); ~30 hand-rolled `useEffect` fetchers with inconsistent refetch/race/error handling and stale data between pages. **Fix:** `React.lazy` + Suspense; adopt React Query (or a shared `useApiQuery`), which also fixes most of H-FE-2.

### Operations
- **H-OPS-2. Health endpoint false-green + process death on transient DB blip.** `/api/health` returns 200 with `status:'degraded'` in the body when `testConnection()` fails (`health.ts:19`); monitors keying on status code see green while the DB is down. `pool.on('error')` → `process.exit(-1)` (`connection.ts:37-40`) — a transient restart kills the process and in-flight money movements. **Fix:** 503 on unhealthy; real round-trip + pool-utilization check; drop `process.exit` for a single idle-client error.
- **H-OPS-3. Zero route-level tests.** All 33 route modules are untested at the HTTP layer (no supertest anywhere); 13 of 49 services have no tests (tokenBlacklist, alerts, scheduler, movementFee, dbClean, loadingReversal, providerCharge, reconciliationStatus, ledgerGates, ledgerQuery, settings, audit); the one API test (`test/api.test.js`) is dead code not wired into any npm script. Auth, RBAC, backup, import, transfer approval, and reversals are all uncovered. **Fix:** supertest-based route tests with a mocked pool; wire or delete the legacy smoke test.
- **H-OPS-4. Backups: manual-only, same-disk, no retention, no restore drills.** (Acknowledged in `system-gaps-plan.md`.) **Fix:** scheduled nightly dump, retention (e.g. 30d), off-machine copy, automated restore drill.
- **H-OPS-5. nginx edge is unhardened.** No `client_max_body_size` (1MB default silently rejects imports/backups), no proxy timeouts (pg_dump/restore can exceed 60s), no security headers for the SPA/static assets, no gzip/caching, no TLS (port 80 only). **Fix:** `client_max_body_size 12m`, `proxy_read_timeout 300s`, headers, gzip, immutable asset caching.
- **H-OPS-6. Single-machine, single-tunnel production with no monitoring.** One Windows PC + one Cloudflare tunnel serves both site and API (`start.bat`, `ecosystem.config.js`); logging is `[ts] METHOD url` only (`middleware/logging.ts:3-7`) — no status/duration/request-id, no rotation, no metrics, no error tracking; crashes die in a Windows console. **Fix:** structured logger with rotation, pm2 `merge_logs`/`max_restarts`, an error-tracking service, consume `/api/health`.

---

## 🟡 Medium (compressed)

- **Security:** CSV formula injection in report exports (`reports.ts:2026-2029`, no `= + - @` neutralization); `sanitizeInput` strips `<` from passwords (self-inflicted lockout) while doing nothing real (all queries are parameterized) — remove it; multer 1.4.5 known DoS family — upgrade to ^2; no CSP/HSTS (also absent at the nginx edge); tokens in localStorage; audit logs mutable by the app role (no append-only trigger); `/api/alerts/generate` triggerable by any `accounts.read` holder; unbounded import row counts; `/health` + `/health/db` leak commit/branch/DB name; token-blacklist cleanup never scheduled; shift-override tokens HMAC'd with the JWT secret; avatar upload is extension/MIME-only.
- **Database:** hot report paths lack composite indexes (account+created_at, account+date, status+created_at, account+status); ~12 migrations have no down sections (023/024 unrevertible); UUID/rule-name-keyed data patches baked into migrations (non-reproducible on restore); missing non-negative CHECKs on `net_amount`/`total_source_deduction`/`destination_amount`/`fee_value`; `updated_at` manual at ~40 sites with a fragile dynamic builder (`corrections.ts:37`); `transfer_entries.ledger_entry_id` dead; seed is not idempotent (`ON CONFLICT` missing).
- **Architecture:** 32 inline copies of the end-of-day bound; `round2` redefined ~15 times; identical `cents` helpers in 4 report services; byte-identical 14-line source query in adjustments vs borrowings (`reports.ts:1804-1817` vs `:1850-1863`); ≥6 endpoints repeat the same scaffolding (the team's R4/R5 options remain open). Unbounded aggregations: `/integrity/run` loads the full transaction table ×4 CTEs, `/reports/consolidated` full-history ×5 tables per dashboard load, `/cash-management/records` materializes everything then paginates in JS; `limit` params have no upper cap.
- **Frontend:** no dialog semantics/focus-trap/Escape on any modal; combobox gaps in GlobalSearch and SearchableSelect (no arrow navigation, out-of-order response races); Dashboard "Last refreshed" lies on total failure; Accounts stale-error bug (one-line `setError('')`); out-of-order preview races in AmountCorrections/FeeAudit; `type="number"` + `parseFloat` money inputs (NaN/locale pitfalls); inline money formatting exceptions (`Accounts.tsx:257`, `Charts.tsx:43`); icon-only buttons lack `aria-label`; ImportData dropzone is a non-focusable `<div>`; sidebar/user-menu lack disclosure semantics.
- **Repo hygiene:** 0-byte `null` file committed; `.env Example.example` stray file; `.env.example` has duplicate keys (PORT, JWT_SECRET); misspelled hardcoded path `C:\Projects\Mutli-...` in `ecosystem.config.js:11` and `start.bat:9`; hardcoded tunnel ID in `start.bat:25`.

---

## Previously documented gaps — current status

From `docs/system-gaps-plan.md` (2026-10-17):

| Gap (Oct 17) | Status (Oct 23) |
|---|---|
| Alerts never fire | ✅ **Fixed** — `startAlertScheduler()` runs at startup (`index.ts:118`), every 15 min with an overlap guard. |
| Money arrives as strings | ✅ **Fixed** — `types.setTypeParser(1700, ...)` in `connection.ts:22`. |
| Duplicate reference numbers accepted | ❌ **Still open** — no partial unique index; only the two shift partial indexes exist in migrations. |
| Off-machine backups | ❌ **Still open** — scheduler has no backup hook; manual, same-disk. |

---

## Recommended order of work

| Wave | Items | Why this position |
|---|---|---|
| **1 — Safety** | C1 backup/restore hardening, C2 import guards, C3 secrets fail-fast, C4 DB timezone pin, H-OPS-1 transfer race | Confirmed, contained, highest stakes — host file access, cross-branch money movement, token forgery, silently shifted day windows, fund-movement race. |
| **2 — Integrity** | H-DB-1..4, H-ARCH-1/2, composite indexes, `money.ts` rounding module, non-negative CHECKs | Make the books structurally safe and auditable. |
| **3 — Confidence** | C5 migration fix, H-OPS-3 route-level tests, C6 CI, H-OPS-4 backup schedule/off-machine, restore drill | Catch regressions by machine, make recovery real. |
| **4 — Experience** | H-FE-1..5, observability (H-OPS-2/6), nginx hardening (H-OPS-5), a11y, code splitting | Operator trust and day-to-day use. |
