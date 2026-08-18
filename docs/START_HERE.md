# Start here: Archive Relay + private OTW Archive

This guide is the primary operator runbook. The other documents provide deeper reference material.

## What the system contains

Two applications cooperate but keep separate databases:

1. **Archive Relay collector** — TypeScript API, workers, Vite interface, MariaDB, raw-response storage, and verified transfer packages.
2. **Private OTW Archive** — Rails application, its own MariaDB, Redis, Memcached, Elasticsearch, and the preservation importer.

The collector never writes directly to OTW tables. Verified packages are the boundary.

---

## Prerequisites

Install:

- Git
- Node.js 20+
- npm 10+
- Docker Engine/Desktop with Compose v2

Verify:

```bash
node --version
npm --version
docker version
docker compose version
```

Keep the repositories as siblings:

```text
parent-directory/
├── ao3-offsite-pipeline/
└── otwarchive/
```

If your OTW checkout is elsewhere, set `OTW_DIR` in `.env.otw-private`.

---

# Part 1 — Development collector

## 1. Install dependencies

```bash
cd ao3-offsite-pipeline
npm install
```

## 2. Configure local development

```bash
cp .env.example .env
```

The checked-in defaults are local-development values. The AO3 source policy itself is stored in MariaDB and edited through the UI.

## 3. Start collector MariaDB

```bash
docker compose up -d --wait collector-db
```

Apply migrations:

```bash
export COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'
npm run db:migrate
```

PowerShell:

```powershell
$env:COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'
```

## 4. Start the control plane

Use separate terminals.

### Terminal 1 — API

```bash
export COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'
npm run api:start
```

### Terminal 2 — Vite interface

```bash
npm run web:dev
```

Open:

```text
http://localhost:5173
```

### Terminal 3 — planner

```bash
export COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'
npm run planner-worker:start
```

### Terminal 4 — package exporter

```bash
export COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'
npm run export-worker:start
```

Do **not** start the source collector merely to browse existing offline data.

## 5. Load the saved offline validation dataset

This performs no AO3 requests:

```bash
export COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'
npm run dataset:load -- datasets/harry-potter-page-1/package
```

Expected:

```text
18 works
79 chapters
15 source identities
203 unique tags
1 series
```

The source is created paused.

## 6. Start source collection only when intentional

```bash
export COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'
npm run worker:start
```

Starting the process is not enough to contact the source: the source must also be enabled in **Source Settings**.

Before enabling, review:

- Browser ID / User-Agent
- Adult-content policy
- Minimum delay
- Daily request count
- Daily byte budget
- Maximum response size
- Request timeout
- Failure attempts
- Optional UTC operating window
- Job range

Recommended initial policy:

```text
Concurrency:          1
Minimum delay:       10 seconds
Daily requests:     250
Run validation cap:  25
Source state:         paused until reviewed
```

Use the emergency pause in Source Settings to stop new claims. An in-flight request is allowed to finish.

---

# Part 2 — Operator authentication

For localhost-only development, `API_TOKEN` is optional.

For shared/private-network access:

```bash
openssl rand -hex 32
```

Set it before starting the API:

```bash
export API_TOKEN='<generated value>'
```

The web interface shows an unlock screen. API calls use:

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  http://127.0.0.1:3001/api/health/ready
```

Always use TLS when crossing a network. A bearer token does not encrypt traffic.

---

# Part 3 — Jobs and packages

## Create a collection job

Use **Collection Jobs → New job**. Creation is fast because the planner expands ranges asynchronously in bounded batches.

Start small. The 10-million-ID API limit is a configuration guard, not a recommended job size.

Job states are durable across process restarts. The planner checkpoints its cursor. Collector tasks use leases and recover when a worker dies.

## Review failures

Use **Failure Review** to inspect:

- Work ID
- Attempts
- Error code/message
- Retryable versus terminal state

Retrying job failures clears terminal errors and reopens only the failed tasks.

## Create a package

Use **Transfer Packages → Queue export**. The export worker:

1. Selects new/changed works.
2. Writes JSONL files.
3. Validates references and counts.
4. Writes checksums.
5. Reopens and verifies the package.
6. Creates `.tar.gz`.
7. Computes archive SHA-256 and size.
8. Marks works exported.

The first non-empty package is a snapshot. Later packages reference the latest completed non-empty parent. Multiple export workers are safe; sequence and parent assignment are serialized per source.

Use **Inspect** to view manifest counts, verification, SHA-256, download, and OTW import status.

---

# Part 4 — Persistent private OTW Archive

## 1. Configure

```bash
cp .env.otw-private.example .env.otw-private
```

Change at minimum:

```dotenv
OTW_ARCHIVIST_PASSWORD=<strong unique password>
```

Default security behavior:

- Binds to `127.0.0.1:3000`
- Outbound email disabled
- `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`
- Work responses private/no-store
- Dedicated `offline_importer` archivist
- Resque disabled in the low-memory profile

## 2. Start

```bash
npm run otw:up
```

Open:

```text
http://localhost:3000
```

Archivist login defaults to:

```text
offline_importer
```

The password remains only in ignored `.env.otw-private`.

## 3. Import a package

Import the saved 18-work package:

```bash
npm run otw:import -- datasets/harry-potter-page-1/package
```

Or import a generated package directory under `data/exports/<package-id>`.

Expected saved validation result:

```text
Works:    18
Chapters: 79
Series:    1
Failed:    0
```

Imports are idempotent. A partial run remains retryable. Source IDs and hashes prevent duplicates.

## 4. Collector callback, optional

In `.env.otw-private`:

```dotenv
COLLECTOR_CALLBACK_URL=http://host.docker.internal:3001/
COLLECTOR_API_TOKEN=<collector token>
```

The importer reports `importing`, `imported`, or `failed` and includes the OTW run ID.

## 5. Low-memory behavior

`OTW_ENABLE_RESQUE=false` keeps memory use lower. Work and chapter pages remain available, but background search indexing is not processed.

On a host with adequate memory:

```dotenv
OTW_ENABLE_RESQUE=true
```

Then rerun:

```bash
npm run otw:up
```

## 6. Stop without deleting records

```bash
npm run otw:down
```

Never add `-v` unless you intentionally want to delete OTW MariaDB volumes.

---

# Part 5 — Production collector deployment

## Configure

```bash
cp .env.production.example .env.production
```

Replace every `change-me` value. Set host UID/GID and a long random API token.

## Start

```bash
npm run production:up
```

Default URL:

```text
http://localhost:8080
```

Only Nginx is published. MariaDB and Fastify remain internal.

## Stop

```bash
npm run production:down
```

See `DEPLOYMENT.md` for TLS, networks, logs, updates, and signed images.

---

# Part 6 — Backups

## Collector

```bash
npm run production:backup
```

Backup contains:

- MariaDB logical dump
- Raw blobs
- Transfer packages
- Metadata
- Checksums

Restore:

```bash
CONFIRM_RESTORE=yes \
  ./scripts/restore-production.sh backups/<timestamp>
```

## Private OTW

```bash
npm run otw:backup
```

Restore:

```bash
CONFIRM_RESTORE=yes \
  ./scripts/otw-private-restore.sh backups/otw/<timestamp>
```

Keep collector and OTW backups off-site. Keep ignored environment files separately in encrypted storage.

---

# Part 7 — Testing

Fast checks:

```bash
npm run check
npm run web:build
npm audit --omit=dev
```

Browser workflows:

```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

MariaDB integration:

```bash
export COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'
npm test -- --run packages/collector/test/store.integration.test.ts
```

This resets collector tables. Never run it on important data.

Complete collector-to-OTW proof:

```bash
npm run test:full-pipeline
```

This uses a disposable OTW test database and must never target the persistent private archive.

---

# Routine operating checklist

1. Confirm the latest collector and OTW backups exist off-site.
2. Start collector API/UI/planner/export workers.
3. Keep the source paused while reviewing jobs.
4. Start source worker only when collecting.
5. Confirm source policy and requested IDs.
6. Enable source.
7. Monitor jobs, failures, and source health.
8. Pause after the planned run.
9. Queue and verify export.
10. Download or import package into private OTW.
11. Confirm OTW work/chapter counts and sample pages.
12. Back up collector and OTW again.

---

# Troubleshooting quick reference

## Docker command unavailable

Install/start Docker and reopen the terminal:

```bash
docker version
docker compose version
```

## API not ready

```bash
docker compose logs collector-db
docker compose logs api
```

For development, verify `COLLECTOR_DATABASE_URL` and port 3307.

## Worker does nothing

Check:

- Source paused state
- Job planning state
- Task availability time
- Daily request/byte budget
- UTC operating window
- Worker logs

## OTW starts but search is stale

Low-memory mode leaves Resque disabled. Enable it only if the host has enough RAM.

## OTW package is partial

Inspect the import output/log, fix the mapping or required canonical tag, then import the same package again. Successful works are skipped and missing works are retried.

## Browser was closed

Closing the browser does not delete MariaDB volumes or workspace files. Restart the API/Vite processes or run the relevant `up` command.

---

# Is the core project done?

The core private preservation pipeline is implemented and proven:

```text
collect → raw snapshot → normalize → package → verify → import → browse → back up → restore
```

Remaining work is optional or operational hardening:

- Metrics and alerting
- Scheduled restore drills
- First signed public release
- Comments
- Embedded assets
- Authenticated/restricted-source policy, if ever explicitly authorized
