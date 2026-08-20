# Implementation plan, findings, and status

> Handoff document written 2026-08-19 so a fresh agent session (especially one
> running inside WSL via Remote-WSL) can resume without re-examining the
> codebase from scratch. Read `AGENTS.md` at the repo root for the quick
> onboarding summary; this file is the full record.

## TL;DR

A six-part rework was implemented and pushed to GitHub (`origin` main, commit
`eecd81c`): one container for the whole collector, large work-ID support
verified, simplified npm scripts, consolidated docs, Raspberry Pi assumptions
stripped, and source-tree cleanup — all under a full-source backup zip taken
first. The project is now migrating to WSL2/Ubuntu.

## The plan (as executed)

0. **Backup** — full tracked-source snapshot zip before any deletion, at
   `backups/source-snapshot/<stamp>/` (gitignored).
1. **Single container** — `docker/Dockerfile` became one image (Node 20 +
   apt MariaDB 10.11 + supervisord). Added `docker/supervisord.conf`,
   `start-mariadb.sh`, `init-mariadb.sh`, `wait-for-mariadb.sh`,
   `mariadb-server.cnf`. Deleted `docker/nginx.conf`; the Fastify API now serves
   the React UI (`@fastify/static`), `/api`, `/healthz`, and the old nginx
   security headers on port 8080. `compose.production.yml` is one `collector`
   service; `env.production.example` points at `127.0.0.1:3306`.
2. **Lifecycle scripts** — `all-services.sh` (default `all` = collector only;
   `otw` scope kept), `setup-all.sh` (collector-only default + `--with-otw`,
   regenerates a stale `.env.production`), `backup-production.sh` /
   `restore-production.sh` (single-container dump/restore).
3. **Large work IDs** — no value cap existed; clarified the 10M range-size
   guard message in the API, added a UI hint, and added an API test proving
   `end=90_919_366` is accepted.
4. **npm scripts** — root has `start/stop/restart/status/logs/backup/reset/
   setup/dev`; removed `services:*`, `production:*`, `otw:*`, and the separate
   `*:start` aliases. `web:build` kept (Dockerfile + CI use it).
5. **Docs** — README rewritten; `docs/` consolidated to
   `GETTING_STARTED/OPERATIONS/DEPLOYMENT/DATABASE/BACKUP_RESTORE/TESTING/
   OTW_ARCHIVE`; six old docs deleted.
6. **Pi + CI** — `release.yml` is amd64-only single image; `ci.yml` builds one
   target; no low-memory/Pi framing remains.
7. **Cleanup** — removed regenerable artifacts (`tmp/`, `test-results/`,
   `*.tsbuildinfo`, `dist`, `dist-types`); `otw-importer/` stays dormant.

## Findings (verified facts)

- **Work IDs**: not value-capped anywhere — API `IdRangeBody`
  (`apps/api/src/app.ts`) uses `start/end: z.number().int().positive()`; UI
  inputs have no `max`; planner schema (`packages/collector/src/planner.ts`)
  uncapped. 90.9M ≪ JS safe-int; BIGINT/string columns fine. Only guard is
  `end - start + 1 <= 10_000_000`.
- **`verify-docs.sh`** requires hidden `.env*.example` twins to match their
  visible copies, all markdown links in README + `docs/*.md` to resolve, and
  shell syntax to be valid. Its link-check step needs `python3` (not present on
  this Windows box — a node equivalent works).
- **CI had no OTW/Rails references**; `ci.yml`'s `container-build` job built both
  `app` and `web` Dockerfile targets (now a single target). CI calls
  `npm run web:build` and `npm test -- --run .../store.integration.test.ts`.
- **`.gitignore`** already excludes `node_modules/ dist/ dist-types/ tmp/
  datasets/ data/ test-results/ playwright-report/ *.tsbuildinfo *.log .env*
  backups/` — so cleanup was working-tree-only and nothing private is tracked.
- **Environment constraints (this Windows machine)**: no Docker daemon reachable
  from PowerShell; no WSL until Ubuntu was installed; Git Bash at
  `C:\Program Files\Git\bin\bash.exe`; no `python3`. The `run_in_terminal` /
  `create_file` permissions in VS Code can be toggled on/off.

## Current status

- **Committed + pushed**: branch `main`, commit `eecd81c` on top of full history.
  Remote `origin` = `https://github.com/billsargent/ao3-scraper2.git`.
- **WSL migration + verification COMPLETE (2026-08-20)** — see AGENTS.md
  "Migration-to-WSL status". All previously-unverified items are now verified
  live: image build, container start + health, UI unlock, high-ID job through
  the workers, a verified `.tar.gz` export, backup/restore drill, MariaDB
  integration tests, and Playwright e2e. `npm run check` = 46 tests (37 unit +
  9 integration when `COLLECTOR_DATABASE_URL` is set); `npm run test:e2e` = 6.
- **Local `main` has one extra commit** beyond `origin/main` (`3e09865`):
  `36d57dd` "Fix container/backup bugs from WSL verification; add statistics +
  dashboard safety features". Check whether it has been pushed.
- **Bugs fixed during verification**: `init-mariadb.sh` socket arg; API auth
  hook blocking the static UI; `supervisord.conf` running node processes as
  root (now `user=node`); `backup-production.sh` compose-exec stdin hang.
- **Features added**: `GET /api/statistics`, `POST /api/exports/:id/verify`,
  per-source `todayUsage` + dashboard pause/resume kill-switch.

## Remaining work (next session)

### C. Optional future (not this session)
- Enable the OTW Archive later via `npm run setup -- --with-otw` + `scripts/otw-private-*.sh` (see `docs/OTW_ARCHIVE.md`).

## Decisions to keep

- Keep MariaDB (no SQLite); keep the three workers as separate supervised
  processes; keep politeness defaults; keep `otw-importer/` dormant in-tree;
  desktop-only (amd64) releases.
