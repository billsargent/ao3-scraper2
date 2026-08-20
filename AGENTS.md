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
- **API token is optional.** The API/UI run with no authentication when `API_TOKEN` is empty (trusted local-only deployments; see `--no-api-token` in `setup-all.sh`). Setting a token re-enables the unlock screen and bearer auth on `/api`.

## Documentation

README.md + `docs/{GETTING_STARTED,OPERATIONS,DEPLOYMENT,DATABASE,BACKUP_RESTORE,TESTING,OTW_ARCHIVE}.md`. `scripts/verify-docs.sh` enforces env-example sync, markdown link resolution, and shell syntax (its link step needs `python3`; a node equivalent works).

## Repo / status

- Remote: `origin` = `https://github.com/billsargent/ao3-scraper2.git`, branch `main`. Local `main` carries one commit beyond `origin/main` (`3e09865`): `36d57dd` ("Fix container/backup bugs from WSL verification; add statistics + dashboard safety features") — check whether it has been pushed.
- Verified: `npm run check` (46 tests — 37 unit + 9 MariaDB integration when `COLLECTOR_DATABASE_URL` is set), `web:build`, `npm run test:e2e` (6 Playwright tests), image build, container start + health, high-ID job through the workers, backup/restore drill, docs links/env-sync, shell syntax.
- API additions since the single-container rework: `GET /api/statistics` (archive aggregates for the Overview), `POST /api/exports/:id/verify` (re-hash the on-disk package), and per-source `todayUsage { requests, bytes }` on `GET /api/sources` (shown as Requests/Bandwidth today on the dashboard, plus a dashboard pause/resume kill-switch).
- Social metadata capture (opt-in, per source): `captureComments` / `captureKudos` / `captureBookmarks` booleans + `maximumCommentPages` / `maximumKudosPages` / `maximumBookmarkPages` caps on `sources` (migration `0012`). The worker fetches comments (work page + each chapter page, reconstructing reply depth from AO3 "Parent" links), kudos (`/works/<id>/kudos`), and bookmarks (`/works/<id>/bookmarks`) inline in the same task, gated by the daily request budget. Exported as `comments.jsonl` / `kudos.jsonl` / `bookmarks.jsonl` first-class transfer records (manifest counts optional for backward compatibility). Comments are per-chapter, so full capture of long works costs one fetch per chapter.

## Migration-to-WSL status (complete)

- Running on WSL2 Ubuntu 26.04 (user `bill`): nvm + Node v20.20.2 / npm 10.8.2, native `docker.io` 29.1.3 + `docker-compose-v2` (Compose v2.40.3), systemd-managed daemon, passwordless sudo via `/etc/sudoers.d/bill`. The Windows npm shim (`/mnt/c/Users/bill/AppData/Roaming/npm/npm`) is in PATH but shadowed by nvm's node.
- Container gotchas found during verification (fixed in-tree): `docker/init-mariadb.sh` needs `--socket="$SOCKET"`; the API auth hook guards only `/api/*` (the static UI + unlock screen must stay public); `docker/supervisord.conf` runs the API + workers as the `node` user so `/data` stays owned by the host user (uid 1000) and destructive restore can replace it; `scripts/backup-production.sh` closes `compose exec` stdin with `< /dev/null` (exec otherwise hangs non-interactively).
- Dev DB for integration tests: `sudo docker compose up -d --wait collector-db` (host port 3307), then `export COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'`.
- Historical Windows gotchas (no longer relevant): Git Bash at `C:\Program Files\Git\bin\bash.exe`; no `python3`; shell scripts show mode-only `M` entries on Windows (harmless).

## Env examples

- Production: `env.production.example` → `.env.production` (`COLLECTOR_DATABASE_URL=mysql://collector:...@127.0.0.1:3306/ao3_collector`).
- Dev DB: `docker-compose.yml` service `collector-db` on host port `3307`; dev URL `mysql://collector:collector_local_only@localhost:3307/ao3_collector`.
