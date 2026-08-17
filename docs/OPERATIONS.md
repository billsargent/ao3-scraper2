# Collector API and worker operations

The control API and worker are now separate processes. MariaDB is authoritative: restarting either process does not lose jobs or task progress.

## Start local dependencies

```bash
cp .env.example .env
docker compose up -d --wait collector-db
set -a
source .env
set +a
npm install
npm run db:migrate
```

Browser identity and source policy are stored in MariaDB and edited through Source Settings. A new source defaults to a standard Chrome User-Agent, accepts adult-content interstitials, and starts paused. You can customize the Browser ID/User-Agent and append a project contact identifier before routine collection.

## Load an existing offline package (optional)

For UI development or recovery testing, load a verified package into the collector without contacting the source:

```bash
npm run dataset:load -- datasets/harry-potter-page-1/package
```

The loader creates the package source paused when needed and transactionally upserts each work. The private Harry Potter validation package is ignored by Git but remains in the workspace where it was captured.

## Start the API

For localhost-only development, authentication is optional. For any shared/private-network access, generate a token first:

```bash
openssl rand -hex 32
```

Set the result as `API_TOKEN` in your environment, then start:

```bash
npm run api:start
```

The default API address is `http://127.0.0.1:3001`. When `API_TOKEN` is set, every `/api` route except liveness requires `Authorization: Bearer <token>`. The Vite interface displays an unlock screen and stores the token in that browser's local storage.

Check health. Add `-H "Authorization: Bearer $API_TOKEN"` to protected curl commands when authentication is enabled:

```bash
curl http://127.0.0.1:3001/api/health/live
curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:3001/api/health/ready
```

## Start the Vite operator interface

In another terminal:

```bash
npm run web:dev
```

Open `http://localhost:5173`. Vite proxies browser requests under `/api` to `http://127.0.0.1:3001`, so the browser never needs to call a separate localhost service directly. The interface currently provides:

- Overview metrics and safety state
- Durable ID-range job creation
- Job progress and pause/resume/cancel controls
- Failure review with recorded code/message and job-level terminal-failure retry
- Server-paginated collected-work list and title/source-ID search
- Offline work/chapter reader using plain text extracted from stored HTML
- Paused-by-default source creation
- Browser ID/User-Agent, adult-content, delay, request/byte budget, timeout, response-size, retry, UTC-window, and emergency-pause settings

The API and UI are unauthenticated in this milestone. Keep both bound to localhost or a trusted private network.

## Create the AO3 source

Sources are created paused as a safety measure:

```bash
curl -X POST http://127.0.0.1:3001/api/sources \
  -H 'content-type: application/json' \
  -d '{
    "key": "ao3",
    "origin": "https://archiveofourown.org",
    "minimumDelayMs": 10000,
    "dailyRequestBudget": 250
  }'
```

The response contains `sourceId`. The Source Settings UI provides granular controls for:

- Browser ID / User-Agent
- Adult-content interstitial acceptance
- Minimum delay between requests
- UTC daily request count
- UTC daily response-byte budget
- Per-response size limit
- Request timeout
- Maximum failure attempts
- Optional UTC operating window, including overnight windows
- Immediate source pause

All pacing, budget, and operating-window checks are transactionally shared by every worker. List sources:

```bash
curl http://127.0.0.1:3001/api/sources
```

## Create a job

Creating a job inserts durable tasks but a paused source prevents workers from claiming them:

```bash
curl -X POST http://127.0.0.1:3001/api/jobs/id-range \
  -H 'content-type: application/json' \
  -d '{
    "sourceId": 1,
    "start": 100,
    "end": 110,
    "batchSize": 100
  }'
```

For safety, this initial API limits one range request to 10,000 IDs. Larger discovery will move to an asynchronous planner.

Inspect jobs:

```bash
curl http://127.0.0.1:3001/api/jobs
curl http://127.0.0.1:3001/api/jobs/1
```

## Start the worker

Starting the worker does not override a paused source:

```bash
npm run worker:start
```

The browser opens an authenticated Server-Sent Events stream at `/api/events`. Job snapshots are pushed every two seconds, with 15-second transport heartbeats and automatic browser reconnection. Thirty-second polling remains as a fallback.

The worker:

1. Claims one MariaDB task with a unique lease token.
2. Reserves a database-backed source request slot.
3. Enforces the source delay and UTC daily request budget across all workers.
4. Heartbeats while a request is running.
5. Stores raw HTML before parsing.
6. Persists normalized records transactionally.
7. Completes, retries, or terminally fails the task.

Retryable failures use bounded exponential backoff with jitter. The default limit is six processing attempts. A crashed worker's expired lease is recovered when another worker starts.

## Start the export worker

Transfer-package requests use a separate durable worker so large exports do not block the API or source collector:

```bash
npm run export-worker:start
```

Queue and inspect exports from the **Transfer packages** UI, or use:

```bash
curl -X POST http://127.0.0.1:3001/api/exports \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"sourceId": 1, "maximumWorks": 500}'

curl -H "Authorization: Bearer $API_TOKEN" \
  http://127.0.0.1:3001/api/exports
```

The first non-empty export is a snapshot. Later exports contain only works whose content hash changed and link to the previous completed package. Requests with no changed works finish as `empty`. Package files are written under `EXPORT_DIRECTORY/<package-id>` and checksummed before works are marked exported.

Run one export worker per collector database in this milestone; multi-worker export lineage serialization is planned hardening.

## Unpause source collection

Do this only after confirming the job range, User-Agent contact, delay, and budget:

```bash
curl -X PUT http://127.0.0.1:3001/api/sources/1 \
  -H 'content-type: application/json' \
  -d '{
    "minimumDelayMs": 10000,
    "dailyRequestBudget": 250,
    "paused": false
  }'
```

Pause immediately without deleting the job:

```bash
curl -X PUT http://127.0.0.1:3001/api/sources/1 \
  -H 'content-type: application/json' \
  -d '{
    "minimumDelayMs": 10000,
    "dailyRequestBudget": 250,
    "paused": true
  }'
```

## Job controls

```bash
curl -X POST http://127.0.0.1:3001/api/jobs/1/pause
curl -X POST http://127.0.0.1:3001/api/jobs/1/resume
curl -X POST http://127.0.0.1:3001/api/jobs/1/cancel
```

Pausing a job prevents new task claims. A task already being processed is allowed to finish. Cancelling marks future queued/retryable tasks cancelled; it does not delete captured content.

## Browse collector records

```bash
curl 'http://127.0.0.1:3001/api/works?limit=25&offset=0'
curl http://127.0.0.1:3001/api/works/1
```

The detailed endpoint currently returns work and chapter metadata, not chapter body HTML. Full browsing will be implemented in the Vite UI with sanitized rendering.

## Stop processes

Use `Ctrl+C` for the API and worker. Both close their MariaDB pools. Worker leases expire and are recoverable if a process is forcibly terminated.

Stop MariaDB while keeping its data volume:

```bash
docker compose down
```

## Current limitations

- Authentication is a single operator bearer token, not multi-user accounts or role-based access.
- Events currently carry job snapshots; per-task log events and historical replay are not implemented yet.
- Large range discovery still happens during the API request, capped at 10,000 IDs.
- Export creation is implemented as a library and integration-tested but is not exposed through an asynchronous API endpoint yet.
- A real contact address is required to run the worker; it is intentionally not committed to the repository.
