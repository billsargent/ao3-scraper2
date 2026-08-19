# Operations

> **Working directory:** Unless a section explicitly says otherwise, run commands from the `ao3-offsite-pipeline` repository root.

The collector is one Docker container. MariaDB is authoritative: restarting the container (or any supervised process inside it) does not lose jobs or progress.

## Ports

| Port | Mode | Service | Open it? |
|---:|---|---|---|
| `8080` | Production | Collector UI + `/api` (same origin) | Yes |
| `5173` | Development | Vite UI | Yes |
| `3001` | Development | Fastify API | Usually no; the UI calls it |
| `3307` | Development | Collector MariaDB host mapping | No |

Health checks:

```bash
curl http://localhost:8080/healthz
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:8080/api/health/ready
```

## Create the AO3 source

Sources are created **paused** as a safety measure. Open **Source settings** in the UI, or:

```bash
curl -X POST http://localhost:8080/api/sources \
  -H "Authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  -d '{"key":"ao3","origin":"https://archiveofourown.org"}'
```

Source policy controls (all enforced transactionally across every worker):

- Browser ID / User-Agent
- Adult-content interstitial acceptance
- Minimum delay between requests
- UTC daily request count and response-byte budget
- Per-response size limit and request timeout
- Maximum failure attempts
- Optional UTC operating window
- Immediate pause

Defaults are conservative on purpose: 10-second minimum delay, 250 requests/day, one request at a time, paused by default. **These protect AO3, not the hardware.** A `0` value means unlimited for delay, budget, size, timeout, or retries.

## Create and control a collection job

```bash
curl -X POST http://localhost:8080/api/jobs/id-range \
  -H "Authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  -d '{"sourceId":1,"start":90800000,"end":90919366,"batchSize":250}'
```

- Work IDs are arbitrary positive integers; AO3 is around 91M and rising, and any value up to JavaScript's safe-integer limit is supported.
- One job covers at most **10,000,000 IDs**. That is a range-size guard, not a ceiling on the IDs themselves — to cover the full current range, start closer to the top or create several jobs.
- The planner worker expands the range durably, the collector worker fetches and parses, and the export worker builds packages.

Job controls:

```bash
curl -X POST http://localhost:8080/api/jobs/1/pause
curl -X POST http://localhost:8080/api/jobs/1/resume
curl -X POST http://localhost:8080/api/jobs/1/cancel
curl -X POST http://localhost:8080/api/jobs/1/retry-failures
```

The worker claims tasks under short leases, reserves database-backed source slots, respects the source delay and daily budgets, heartbeats, stores raw HTML before parsing, persists records transactionally, and completes, retries, or terminally fails each task. Retries use bounded exponential backoff with jitter (default six attempts). Expired leases from a crashed worker are reclaimed automatically.

## Transfer packages

Queue an export from the **Transfer packages** UI, or:

```bash
curl -X POST http://localhost:8080/api/exports \
  -H "Authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  -d '{"sourceId":1,"maximumWorks":500}'
```

The first non-empty export is a snapshot; later exports contain only changed works and link to the previous package. Requests with no changed works finish as `empty`. Packages are written, verified, and compressed to `.tar.gz` before works are marked exported.

Inspect and download:

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:8080/api/exports/1/manifest
curl -OJ -H "Authorization: Bearer $API_TOKEN" http://localhost:8080/api/exports/1/download
```

## Monitoring and troubleshooting

- `npm run status` — container health
- `npm run logs` — container logs (MariaDB, API, and workers all write to the same stream)
- `docker exec -it <container> supervisorctl status` — per-program status (`mariadb`, `api`, `collector-worker`, `planner-worker`, `export-worker`)
- **Debug log** in the UI keeps the last 200 browser-to-API requests with status, duration, and request ID (bodies and tokens are never recorded)

## Full reset

```bash
CONFIRM_RESET=ERASE_ALL npm run reset
```

Deletes containers, database volumes, blobs, and exports. Source code, backups, and `.env` files are preserved unless you also set `ERASE_BACKUPS=yes` or `ERASE_CONFIG=yes`.

## Next

- [Backup and restore](BACKUP_RESTORE.md)
- [Deployment](DEPLOYMENT.md)
- [Database](DATABASE.md)
- [Testing](TESTING.md)
