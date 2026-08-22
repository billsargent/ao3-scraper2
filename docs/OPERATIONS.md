# Operations

> **Working directory:** Unless a section explicitly says otherwise, run commands from the `ao3-offsite-pipeline` repository root.

The collector is one Docker container. MariaDB is authoritative: restarting the container (or any supervised process inside it) does not lose jobs or progress.

The API token is **optional**. Leave `API_TOKEN` empty in `.env.production` (or run `npm run setup -- --no-api-token`) to run with no authentication on a trusted network — the UI loads straight to the dashboard with no unlock screen. When a token is set, `/api` requires `Authorization: Bearer $API_TOKEN`. The curl examples below send the header regardless; it is harmless when no token is configured.

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

## Tag archive (archive by tag)

The **Tag archive** UI page prioritises collection by AO3 tag instead of by ID range — useful for grabbing a fandom, pairing, or freeform tag's works without planning an ID-range job.

- **Subscribe**: one-click relationship presets (M/M, F/F, F/M, Gen, Multi), or search — the live search hits AO3's tag search, and local matches cover tags already in your archive — then subscribe.
- **Crawl**: while the source is enabled and not paused, the collector worker fetches one page of each enabled subscription's `/tags/<slug>/works` listing (newest first) roughly every 10 minutes, keeps only works you don't already have (not collected, not queued, not known gone), queues them as a small explicit-IDs job, and advances that tag's page cursor. The queue backlog is capped and only one page per subscription runs per cycle.
- **Queue now**: fetch the next page of a subscription immediately from the UI instead of waiting for the next cycle.
- **Controls**: per-subscription auto-fill on/off, remove, and status (next page, last run, last job).

API:

```bash
curl -H "Authorization: Bearer $API_TOKEN" "http://localhost:8080/api/tags/search?sourceId=1&q=harry%20potter"
curl -H "Authorization: Bearer $API_TOKEN" "http://localhost:8080/api/tags/local?sourceId=1&q=harry"
curl -X POST -H "Authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  "http://localhost:8080/api/tags/subscriptions?sourceId=1" \
  -d '{"tagName":"M/M","tagSlug":"M%2FM","tagType":"Category"}'
curl -X POST -H "Authorization: Bearer $API_TOKEN" "http://localhost:8080/api/tags/subscriptions/1/queue"
curl -X PUT -H "Authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  "http://localhost:8080/api/tags/subscriptions/1" -d '{"enabled":false}'
curl -X DELETE -H "Authorization: Bearer $API_TOKEN" "http://localhost:8080/api/tags/subscriptions/1"
```

Confirm the crawler is running from **Debug log → Worker logs**: `tag_auto_fill_created` (works queued), `tag_auto_fill_skipped` (page already fully known), `tag_auto_fill_exhausted` (past the end of the listing), and `tag_auto_fill_failed` (fetch/parse error).

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
