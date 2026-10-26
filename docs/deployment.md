# Deployment and Operations

**Date:** 2026-10-26
**Scope:** How the two halves of this system are deployed, the exact commands, and what changes when `NODE_ENV=production` is set.
**Method:** Written from the live box — every command and behaviour below was executed and observed, not recalled. Where something was observed to work differently than expected, it says so.

---

## Topology

| Piece | Where it runs | Deployed by |
|---|---|---|
| Frontend (React/Vite) | Vercel | `git push` to `main` — see `vercel.json` |
| Backend (Express/TS) | This box, PM2 app `monitor-backend`, port 3001 | build + PM2 reload (below) |
| Database | PostgreSQL 18.4 on this box | migrations, run by hand |

- `vercel.json` builds `npm run build:frontend` and serves `packages/frontend/dist`, with an SPA rewrite to `index.html` for everything that is not `/assets/`. There is **no** `/api` rewrite: the browser calls the API on its own host.
- The API host (`mapi.primeclc.com`) is a Cloudflare tunnel whose connector is a process on this box, so every request arrives from loopback. That is why `app.set('trust proxy', 'loopback')` (`index.ts:32`) is correct rather than a hop count — it also means a request hitting port 3001 directly cannot forge `X-Forwarded-For`.
- PM2 on this box also runs unrelated applications (`nurselearn-api`, `nurselearn-tunnel`). Scope every PM2 command to `monitor-backend`.

---

## Backend deploy

```powershell
cd "C:\Projects\Mutli-Account Balance & Transaction Monitoring System"
git fetch origin
git merge --ff-only origin/main        # refuses if local history has diverged
npm run build:backend                  # tsc, then scripts/build-info.js -> "<short> @ <branch>"
pm2 startOrReload ecosystem.config.js --update-env
Invoke-RestMethod http://localhost:3001/api/health
```

The production checkout is the working tree at the path above; `ecosystem.config.js` names it as `cwd` and runs `packages/backend/dist/index.js` — the built output, not `src`. `dist` only changes on an explicit `npm run build:backend`, so a deploy is always a deliberate act.

**Health check.** Expect `status: healthy`, `database: connected`, and a `commitShort` matching what you just built, `branch: main`, `dirty: false`.

- `dirty: true` means uncommitted changes are being served from that checkout. Do not ship that.
- Startup takes ~2–3 seconds. An immediate check can be refused; wait and retry rather than assume failure.

### Use `startOrReload`, not `restart`, when the env changed

`pm2 restart monitor-backend --update-env` re-applies the environment PM2 **already holds** for that app. It does **not** re-read `ecosystem.config.js`. Observed on 2026-10-26: after adding `NODE_ENV: 'production'` to the file and running `pm2 restart monitor-backend --update-env`, `pm2 jlist` showed the app had no `NODE_ENV` at all and the log still printed `Environment: development` — with every command reporting success. Only `pm2 startOrReload ecosystem.config.js --update-env` re-read the file and applied it.

So:

- **Anything touching `ecosystem.config.js`** → `pm2 startOrReload ecosystem.config.js --update-env`.
- **Code-only change** (no env difference) → `npm run build:backend; pm2 restart monitor-backend` is enough and is one step shorter.

### Environment precedence

`ecosystem.config.js` env **>** the process/shell environment **>** `packages/backend/.env`. `dotenv` never overwrites a variable that is already set (`config/index.ts:4`), which is why `NODE_ENV: 'production'` in the PM2 file wins over the `development` sitting in `.env`.

`.env` is gitignored and lives at `packages/backend/.env` on the box. It cannot be changed through a commit — edit it in place.

**Consequence worth knowing:** the backend's CLI scripts (`npm run migrate`, `db:clean`, `seed` — all ts-node, not PM2) run outside PM2's environment, so they see `.env` alone. In production that means `NODE_ENV` is `development` for them, and a guard keyed on production does not trip.

---

## What `NODE_ENV=production` changes

| Behaviour | Where | Effect |
|---|---|---|
| Startup secret guard | `services/configGuard.ts`, called at the top of `startServer()` (`index.ts`) | Refuses to start when `JWT_SECRET` is missing, shorter than 32 characters, or a placeholder published in this repository. Prints a warning — not a refusal — when `DB_PASSWORD` is unset or still `development`'s `postgres`. |
| `POST /api/backup/clean` | `routes/backup.ts:174` | Returns **403**. This is designed, not a regression: wiping live data is not something the running server should offer. Use the CLI below. |
| CORS | `index.ts:37-41` | `CORS_ORIGIN` unset → `false`, browsers blocked entirely. `*` → reflect any origin. Otherwise a comma-separated list of origins. Currently `*`. |
| Startup log | `index.ts:109` | Prints `Environment: production`. |

Development is deliberately never refused by the guard: a fresh clone with no `.env` runs on `dev-jwt-secret`, and that first run should work.

**Running the cleaner in production.** From the production checkout:

```powershell
npm run db:clean --workspace=packages/backend              # dry run: prints the plan, changes nothing
npm run db:clean --workspace=packages/backend -- --commit  # real clean: verified backup first
```

It only acts with `--commit`, and a real clean takes a verified backup before it touches anything (`clean.ts:131-148`); open shifts refuse it without `--force`, because someone may be mid-till.

Because the CLI runs outside PM2 it reads `.env`, where `NODE_ENV` is still `development`, so the production guard (`clean.ts:114`) does not trip and `--allow-production` is not needed. If you instead export `NODE_ENV=production` in that shell, the guard will refuse without it.

**Startup messages** appear in `~/.pm2/logs/monitor-backend-out.log` and `-error.log`. Request-log lines are timestamped; startup lines are not.

---

## Before shipping anything

```powershell
# backend — tsc, then node:test
cd packages\backend; npm run test:build

# frontend — vitest, then the production build
cd packages\frontend; npm test; npm run build
```

Both suites must be fully green. The backend count moves as tests are added, so read the summary rather than a remembered number.

---

## Operational follow-ups still open

- **`DB_PASSWORD` is still `postgres`.** Acceptable only while the database listens on localhost. Until it is rotated, every production start prints a configuration warning — that warning is the reminder, not noise.
- **`CORS_ORIGIN='*'` with `credentials: true`** reflects any origin while cookies are accepted (tracked as H-SEC-5 in `docs/system-audit-2026-10-23.md`). Setting `CORS_ORIGIN` to the real frontend origin and the API host closes it without any code change — but note that removing the variable entirely blocks browsers outright (see the CORS row above).
- **Off-machine backups are not in place.** Skipped deliberately for now; `docs/system-gaps-plan.md` records the gap.
