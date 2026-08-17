# Implementation plan from the current checkpoint

_Date: 2026-08-17_

## Current proven checkpoint

The project already has:

- TypeScript transfer-package contract, writer, verifier, and linked incremental fixtures
- Fixture-driven AO3 entire-work parser
- Conservative serialized HTTP client
- MariaDB/Drizzle collector schema and migration
- Normalized persistence for works, chapters, public authors, tags, series, and observations
- Gzip content-addressed raw HTML storage
- Native OTW Rails importer with source identities and incremental reconciliation
- MariaDB integration tests: **2 passing**
- TypeScript unit tests: **19 passing**
- OTW importer integration tests: **6 passing, 0 failures**
- Beginner Docker setup documentation

The next objective is to turn these proven components into a resumable operator-controlled application.

### Progress since this roadmap was written

- Completed atomic MariaDB task claiming, lease ownership, heartbeats, expired-lease recovery, pause/resume/cancel, and transactional counters.
- Completed snapshot package export from normalized MariaDB records.
- Captured the approved first Harry Potter search-results page once at a 10-second minimum delay. Eighteen of twenty work responses were retained and reprocessed offline; two HTTP 525 responses were left alone.
- Added a sanitized single-chapter fixture and now support both AO3 single- and multi-chapter page shapes.
- Completed UTC daily-budget accounting, database-backed distributed source request slots, byte accounting, retry policy wiring, and the long-running worker process.
- Completed persistent export-run tracking, automatic selection by exported content hash, snapshot/incremental lineage, and unchanged-work exclusion.
- Completed the initial Fastify API for health, safe source creation/configuration, ID-range jobs, job controls, and work browsing.
- Completed the first responsive React/Vite operator interface: overview, job creation/control, work library, and source safety settings.
- Remaining Milestone 2 work: OTW import-status tracking and recovery/finalization of an export interrupted after file creation.
- Remaining Milestone 4 work: authentication, Server-Sent Events, asynchronous large-range planning, and asynchronous export endpoints.

---

## Milestone 1 — durable MariaDB task execution

### Work

1. Add atomic task claiming for MariaDB 10.11 using short leases.
2. Add worker identity, lease expiration, and heartbeats.
3. Recover tasks automatically when a worker dies.
4. Add bounded retry scheduling with exponential backoff and jitter.
5. Add terminal outcomes for deleted, unavailable, restricted, malformed, and parser-failed works.
6. Implement job pause, resume, cancel, and retry-failures operations.
7. Derive job counters transactionally rather than trusting worker memory.
8. Add graceful worker shutdown.
9. Enforce a database-backed source-wide request slot so multiple processes cannot exceed the configured source delay.
10. Enforce daily request and optional bandwidth budgets.

### Tests

- Two workers cannot claim the same task.
- An expired lease is reclaimed.
- A live lease is not reclaimed.
- Retrying a discovery batch does not create duplicate tasks.
- Pause prevents new claims but does not corrupt active work.
- Cancel stops future work.
- A 429 pauses/retries without task loss.
- Restarting API and worker processes preserves all progress.

### Exit condition

A 1,000-ID fixture-only job can be interrupted at arbitrary points, restarted, and completed with exactly one terminal outcome per task and no duplicate normalized works.

---

## Milestone 2 — package export from MariaDB

### Work

1. Export selected completed works directly from normalized MariaDB records.
2. Produce bounded packages, initially 100–500 works each.
3. Track package IDs, previous-package lineage, exported work hashes, and export timestamps.
4. Generate snapshot and incremental packages.
5. Verify packages after writing and before offering them to OTW.
6. Add an export report for incomplete works and unresolved references.
7. Add a package-import status table so the UI can distinguish collected, exported, and imported content.

### Tests

- MariaDB records round-trip through an exported package.
- Unchanged works are absent from an incremental package.
- Changed works and new chapters appear in the next package.
- Package splitting never separates a work from its chapters/tags/authors.
- Checksums and manifest counts remain valid.
- Export interruption leaves no package that appears complete.

### Exit condition

A collected fixture work can be exported from MariaDB and imported into OTW without hand-editing files or contacting AO3 again.

---

## Milestone 3 — source-page classification and limited live validation

This phase should make only a very small number of deliberate requests. It is not a crawl.

### Work

1. Validate the parser against a few permitted current public work shapes, preferably works controlled by project participants.
2. Sanitize each captured response and add it as a regression fixture.
3. Add classifiers for:
   - Public entire work
   - Multi-chapter work
   - Anonymous work
   - Orphaned work
   - Adult-content interstitial
   - Restricted/login-required work
   - Deleted/not-found work
   - Mystery work/challenge reveal state where observable
4. Detect unexpected HTML shapes and automatically pause rather than repeatedly retry.
5. Parse co-authors, multiple series, chapter publication dates, work end notes, and unusual Unicode tags.
6. Validate content-length, expected chapter count, and required tag invariants.
7. Store the raw response before every parse attempt.

### Operating requirements

- One configured source origin
- One request at a time
- Five-second default minimum delay
- Descriptive User-Agent with a real team contact address
- No CAPTCHA bypass, proxy rotation, or authentication bypass
- Explicit operator pause control

### Exit condition

All approved live examples parse into validated records, and every discovered page shape has a sanitized fixture test. No broad crawl begins in this milestone.

---

## Milestone 4 — Fastify control API

### Initial endpoints

- `GET /api/health/live`
- `GET /api/health/ready`
- `GET /api/sources`
- `PUT /api/sources/:id`
- `POST /api/jobs/id-range`
- `POST /api/jobs/explicit-ids`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `POST /api/jobs/:id/pause`
- `POST /api/jobs/:id/resume`
- `POST /api/jobs/:id/cancel`
- `POST /api/jobs/:id/retry-failures`
- `GET /api/jobs/:id/events` using Server-Sent Events
- `GET /api/works`
- `GET /api/works/:id`
- `GET /api/failures`
- `POST /api/exports`
- `GET /api/exports/:id`

### Requirements

- Zod request and response contracts
- Generated OpenAPI documentation
- Strict source-origin allowlisting
- Authentication before exposure outside localhost/private networking
- Pagination on all list endpoints
- No long-running scrape inside an HTTP request
- Structured errors without private content or credentials

### Exit condition

Every job lifecycle operation and package export can be controlled through tested API calls while workers run independently.

---

## Milestone 5 — Vite operator interface

### Screens

1. **Dashboard** — source status, active jobs, throughput, stored works/chapters, failure rate, storage usage
2. **New job** — ID range or explicit IDs, request budget, adult-content choice, content options
3. **Job detail** — progress, outcomes, ETA range, live events, pause/resume/cancel
4. **Works browser** — search/filter/sort and completeness indicators
5. **Work detail** — metadata, chapters, tags, source identities, series, capture history, hashes
6. **Failures** — grouped error reasons with inspect/retry/ignore actions
7. **Exports** — create, verify, download, and track OTW import status
8. **Settings** — source origin, User-Agent contact, minimum delay, daily budget, storage paths

### Requirements

- React + Vite + TypeScript
- TanStack Query for API state
- Accessible keyboard and screen-reader behavior
- Responsive layout
- Sanitized and isolated archived-HTML preview
- No credentials or unrestricted scraped HTML in browser storage

### Exit condition

A non-expert operator can create, monitor, interrupt, resume, inspect, export, and retry a collection job entirely through the UI.

---

## Milestone 6 — automated end-to-end pipeline test

### Scenario

1. Start MariaDB collector service.
2. Apply collector migrations.
3. Load local HTTP fixtures through a test source server—no AO3 traffic.
4. Create a collection job through Fastify.
5. Run a worker and collect raw plus normalized content.
6. Export a transfer package.
7. Start disposable OTW dependencies.
8. Apply the importer overlay and migration.
9. Import the package.
10. Open the resulting OTW work and series records.
11. Apply an updated fixture and incremental package.
12. Verify no duplicate work/chapter/series records.

### Exit condition

One command proves the complete local path:

```text
fixture source → collector → MariaDB/raw blobs → package → OTW Archive
```

---

## Milestone 7 — operational hardening

### Work

- Health checks and structured logs
- Metrics for requests, 429/5xx responses, parser failures, queue age, throughput, and storage
- Automatic source circuit breaker
- Database and blob backup scripts
- Restore drill documentation
- Package retention policy
- Collector database migration policy
- OTW importer upgrade compatibility checks
- CI for TypeScript, MariaDB integration, and OTW importer tests
- Email-disabled/private OTW deployment profile
- `noindex` and network-access controls for the offline archive

### Exit condition

The team can deploy, update, back up, restore, pause, and diagnose the system using documented procedures.

---

## Later scope — deliberately deferred

### Comments

Comments require pagination, tree reconstruction, guest/source identity policy, deleted/hidden states, timestamp handling, and additional source traffic. Preserve works first.

### Embedded assets

Images and media require a separate bandwidth budget, content-type validation, storage policy, and URL rewriting strategy.

### Native social statistics

Source kudos, bookmarks, comments counts, and hits should remain timestamped source observations. They should not be recreated as local user actions.

### Authenticated/restricted works

Do not implement until the team has explicit authorization, a secure credential design, and a clear access policy. Never bypass source access controls.

---

## Immediate implementation order

The completed foundation now includes durable workers, source budgets, package export, local fixture end-to-end collection, the Fastify API, the first Vite interface, and the approved live validation dataset. The next coding sequence is:

1. API authentication for anything beyond localhost
2. Server-Sent Events and detailed failure inspection
3. Asynchronous large-range planning and export jobs
4. Package-to-OTW import status and operator workflow
5. Browser-level tests for dashboard/job/settings flows
6. One-command low-memory collector-to-OTW integration test
7. Deployment and backup profiles

---

## Remaining team input

The live validation dataset, delay, request budgets, adult-content policy, and private/restricted OTW default are now decided. Before routine source collection, the worker still requires one value that is intentionally not committed:

- A real team contact address for the collector User-Agent

Fixture-only development, API/UI work, package export, and OTW import testing do not require that value.