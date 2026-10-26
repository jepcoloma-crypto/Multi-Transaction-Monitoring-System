# Database authentication hardening — plan only, not executed

**Status: proposed. Nothing here has been run.** Every fact below was verified
read-only against the live box on 2026-10-26.

## Why the obvious fix does not work

`docs/system-audit-2026-10-23.md` lists "rotate `DB_PASSWORD`" as an
environment-only change worth minutes. It is not, because the password is never
checked.

The live instance is **PostgreSQL 18.4** on port 5432, and its `pg_hba.conf`
authenticates loopback with `trust`:

```
host  all  all  127.0.0.1/32  trust
host  all  all  ::1/128       trust
```

`trust` skips authentication entirely. Verified by connecting with a
deliberately wrong password and with no password at all — both succeeded as
the superuser `postgres`. So `DB_PASSWORD=postgres` in `.env` is decorative,
and the startup warning about the default password points at a value the
server never looks at.

Two further facts, both verified:

- `listen_addresses = '*'` on **both** installed instances (5432 and 5433),
  so PostgreSQL binds every interface. The only thing between 5432 and the LAN
  is the Windows firewall, which currently has **no** rule allowing 5432/5433
  inbound. `trust` + `listen_addresses='*'` + one firewall toggle away is the
  real exposure, not the password strength.
- The `postgres` role's stored verifier is already `SCRAM-SHA-256$4096:…`
  (133 chars), and `password_encryption` is `scram-sha-256`. The role can
  therefore satisfy a scram requirement as-is; no re-hashing step is needed.

## Why this is not a single-project change

The instance hosts **12 databases**, all owned by `postgres`, and it is shared
with four other projects on this box. Their connection strings:

| Project | Database | Connection string |
|---|---|---|
| This system | `multi_account_monitor` | `packages/backend/.env` — `DB_PASSWORD=postgres` |
| NurseLearn PH | `nurselearn_ph` | `postgresql://postgres:postgres@localhost:5432/nurselearn_ph` |
| Multi-Asset Market Intelligence | `market_intelligence` | `postgresql://postgres@localhost:5432/market_intelligence` — **no password** |
| Multi-Company Teller & Financial | `teller_finance` | `postgres://postgres@localhost:5432/teller_finance` — **no password** |
| Solar Energy Monitoring | `solar_energy` | `postgresql://postgres@localhost:5432/solar_energy` — **no password** |

Three of the five supply no password. Flipping `pg_hba` without touching them
breaks market intelligence, teller finance, and solar energy on their next
reconnect.

Also on the instance and **not yet traced to a client**: `ai_sems`, `itsm`,
`nurselearn_ph_prod`, `nurse_handover_dev`, `teller_finance_test`,
`trading_mgmt`. Some belong to projects with no `.env` found (`ClinicSystem`,
`LendingApp`, `Tri-Sakay`, `NurseHandover`, `Service Management System`).
Step 1 below exists to settle this rather than assume.

## The plan

Ordered so that no step can strand a client: passwords are correct *before*
authentication is enforced.

**1. Enumerate every client.** `SELECT usename, datname, client_addr,
application_name FROM pg_stat_activity` while each project is running, plus a
grep of every project directory for `DATABASE_URL`/`DB_HOST`. Anything found
here that is not in the table above gets an `.env` before step 4.

**2. Pick one strong password and set it.**

```sql
ALTER ROLE postgres PASSWORD '<generated, ≥24 chars, kept in the password manager>';
```

Safe under `trust`: the server ignores passwords, so nothing disconnects. This
writes a fresh scram verifier for the new value.

**3. Update every connection string.** At minimum the five in the table above.
Each is a one-line edit; each app must be restarted afterwards to pick it up.

**4. Verify each app on the new password while `trust` is still on.**
Trust would hide a typo here, so prove it explicitly first: connect to each
database using that app's own connection string and the new password. A
success here is real, because scram will be what answers in step 5.

**5. Enforce.** In `pg_hba.conf` for the 5432 instance, change the two loopback
lines from `trust` to `scram-sha-256`, then reload:

```sql
SELECT pg_reload_conf();   -- or pg_ctl reload -D "C:\Program Files\PostgreSQL\18\data"
```

A reload does **not** drop existing connections — already-open sessions keep
running, and only new connections need the password. That is what makes this
recoverable rather than a cliff.

**6. Confirm.** Re-run the probe that proved `trust`: a wrong password must now
be refused with `28P01`. Then check each app's health endpoint and its logs.

**Rollback,** if anything fails at step 5 or 6: change the two lines back to
`trust` and reload again. Immediate, no data touched.

## Decisions still needed

- **Whether to tighten `listen_addresses`** to `localhost` at the same time.
  Everything connects over loopback, so `'*'` buys nothing here. Doing it in
  the same reload is tempting but couples two changes; keeping it separate
  means a second, smaller window. Recommend: separate, after scram is proven.
- **The 5433 instance (PostgreSQL 14)** carries the same `trust` lines. Is it
  used by anything? If not it should not be running at all.
- **Who owns the other four projects.** Step 3 touches their files. If they
  have other operators, they need a heads-up before their next restart.
- **Where the password lives.** One password shared by five apps on one box is
  the current shape and the simplest to reload. Per-app roles would be better
  hygiene and more work; this plan assumes the shared password, and says so
  rather than leaving it implied.
