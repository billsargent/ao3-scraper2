# AGENTS.md — Archive Relay (ao3-offsite-pipeline)

Fast onboarding for AI coding agents. **Read this before exploring the codebase** — it captures the current architecture, decisions, status, and environment gotchas so you don't have to re-derive them.

## What this is

A private, offline preservation pipeline for AO3 fanworks ("Archive Relay"). It politely collects public AO3 work pages, stores them in MariaDB, and exports verified transfer packages (JSONL + SHA-256 manifests) that can later be imported into a self-hosted OTW Archive. TypeScript monorepo, plus an optional/dormant Rails importer (`otw-importer/`).

## Runtime architecture (current)

- **Single production container** — `compose.production.yml` service `collector` (project `archive-relay`), built by `docker/Dockerfile` (`node:20-bookworm-slim` + apt `mariadb-server mariadb-client supervisor`).
- Inside, under `docker/supervisord.conf`:
  - `mariadb` — on `127.0.0.1:3306`, **not** exposed to the host
  - `db-init` (one-shot) — `docker/init-mariadb.sh` sets the root password and creates/syncs the collector DB + user from env
  - `api` — Fastify: serves the React UI + `/api` + `/healthz` on port **8080** (nginx removed; `@fastify/static` in `apps/api`)
  - `collector-worker`, `planner-worker`, `export-worker`
- Data: named volume `collector-mariadb` (`/var/lib/mysql`) + `DATA_DIR` bind (`/data` → `./data` for blobs and exports).

## Commands (root `package.json`)

- Lifecycle: `npm start` / `stop` / `restart` / `status` / `logs` / `backup` / `reset` / `setup` (`setup-all.sh --start`). `npm run dev` = concurrently runs api + 3 workers + web UI.
- Tests/tooling: `check` (`tsc -b --force` + vitest), `test`, `test:e2e`, `web:build`, `db:migrate`, `docs:verify`, `dataset:*`, `package:*`.
- All lifecycle scripts are bash (`scripts/*.sh`, helpers in `scripts/lib/docker.sh`).

## Key decisions (do not silently reverse)

- **Work IDs are not value-capped.** `start`/`end` are positive ints (AO3 is ~91M and rising). The only guard is `end - start + 1 <= 10_000_000` per job (a range-size limit, not a value cap). Backend message + UI hint explain this; API test covers `end=90_919_366`.
- **OTW importer is deferred/dormant but kept** in `otw-importer/`. Opt-in later via `npm run setup -- --with-otw` + `scripts/otw-private-*.sh`. See `docs/OTW_ARCHIVE.md`.
- **Politeness defaults stay** (10s min delay, 250 req/day, paused-by-default) — they protect AO3, not hardware.
- **MariaDB stays** (the lease/concurrency/crash-recovery model depends on it; no SQLite).
- **Desktop-only / no Raspberry Pi**: amd64-only CI + release, no low-memory framing.

## Documentation

README.md + `docs/{GETTING_STARTED,OPERATIONS,DEPLOYMENT,DATABASE,BACKUP_RESTORE,TESTING,OTW_ARCHIVE}.md`. `scripts/verify-docs.sh` enforces env-example sync, markdown link resolution, and shell syntax (its link step needs `python3`; a node equivalent works).

## Repo / status

- Remote: `origin` = `https://github.com/billsargent/ao3-scraper2.git`, branch `main`. Pushed 2026-08-19 (commit `eecd81c`); full history preserved; one rework commit on top.
- Verified so far: `npm run check` (37 tests pass; 9 MariaDB-integration tests skip without a DB), `web:build`, `bash -n` on all scripts, docs links/env-sync, YAML parse.
- **Not yet verified (needs Docker):** image build, container start, a high-ID job through the workers, backup/restore drill, MariaDB integration tests, Playwright e2e.

## Migration-to-WSL status (in progress)

- WSL2 Ubuntu installed (user `bill`). **Node not installed** (nvm needed); the Windows npm shim leaks into the WSL PATH and must be shadowed by an nvm Node 20. **Docker not installed** — decide: native `docker.io` inside Ubuntu vs Docker Desktop WSL2 backend. Repo not yet cloned inside WSL.
- Windows-side gotchas: the run_in_terminal/create_file permission can be toggled off/on; Git Bash is at `C:\Program Files\Git\bin\bash.exe`; there is no `python3`; the 19 shell scripts show mode-only `M` entries on Windows (Windows can't set `+x`) — harmless, clean on Linux/WSL.

## Env examples

- Production: `env.production.example` → `.env.production` (`COLLECTOR_DATABASE_URL=mysql://collector:...@127.0.0.1:3306/ao3_collector`).
- Dev DB: `docker-compose.yml` service `collector-db` on host port `3307`; dev URL `mysql://collector:collector_local_only@localhost:3307/ao3_collector`.
