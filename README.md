# AO3 Off-site Pipeline

A private, offline pipeline for moving conservatively collected public AO3 work data into a functional OTW Archive installation.

This is a fresh project. The cloned `ao3-scraper` and `otwarchive` repositories are references only.

**New operator? Start with [`docs/START_HERE.md`](docs/START_HERE.md).** It covers development, production, collection safety, package export, persistent OTW setup/import, backups, testing, and troubleshooting in one sequence. See [`docs/PORTS_AND_HARDWARE.md`](docs/PORTS_AND_HARDWARE.md) for every port and Raspberry Pi sizing.

Complete setup and lifecycle:

```bash
npm run setup:all -- --start
npm run services:status
npm run services:backup
npm run services:stop
CONFIRM_RESET=ERASE_ALL npm run services:reset
```

## Current vertical slice

Implemented:

- Versioned `ao3-offsite-transfer` v1 contract in TypeScript/Zod
- Works, chapters, public source identities, typed tags, series records, and availability observations
- Streaming JSONL package files
- SHA-256 integrity manifest
- Cross-record reference and duplicate validation
- Package writer, reader, verifier, and sample CLI
- Rails/OTW importer overlay with provenance tables
- Native `Work`, `Chapter`, OTW tag, and `Series` creation/update logic
- Source identity byline display without fake email addresses or local user accounts
- Package-level idempotency and work/chapter/series source identifiers
- Base and incremental cross-language fixtures for update testing
- Fixture-driven AO3 entire-work HTML parser for metadata, chapters, authors, tags, and series
- Conservative source client with origin allowlisting, serialized requests, delay floor, `Retry-After`, retries, timeouts, and response-size limits
- MariaDB/MySQL collector schema and generated Drizzle migration
- Durable asynchronous ID-range planner with leased checkpoints, bounded batches, idempotent crash recovery, and a 10-million-ID guard
- Transactional collector persistence for works, chapters, authors, tags, series, and availability
- Gzip content-addressed raw HTML storage
- Streaming ID-range planner and end-to-end work task processor
- Atomic MariaDB task claiming, leases, heartbeats, expired-lease recovery, and job pause/resume/cancel
- Database-backed distributed request slots, UTC request/byte budgets, operating windows, and response accounting
- Configurable Browser ID/User-Agent with a standard Chrome default, adult-content policy, timeout, response-size, and retry controls
- Continuously running worker with graceful shutdown and bounded retry scheduling
- Durable asynchronous export queue with per-source leases and monotonic sequence numbers, verified snapshot/incremental packages, reproducible `.tar.gz` downloads, SHA-256 metadata, empty-run detection, and exported-hash tracking
- Per-package OTW import workflow/status with timestamps, errors, optional OTW run IDs, and automatic callbacks from the Rails importer
- Fastify control API with optional constant-time bearer-token authentication and authenticated Server-Sent Events
- Responsive React/Vite operator interface with token unlock, dashboard, jobs, failure review/retry, asynchronous transfer-package inspection, paginated library, offline chapter reader, and granular source policy
- Playwright browser coverage for authentication, job creation/control, pagination, reading, source policy, package inspection, download, and OTW status
- One-command low-memory pipeline proof from fixture parsing through MariaDB export into native OTW works, chapters, tags, source identities, and series
- Persistent private OTW profile with noindex/private-cache headers, email disabled, dedicated archivist account, package imports, and OTW backup/restore
- Production Docker profile with health checks, internal networking, restart policies, Nginx security headers, bounded logs, and automatic migrations
- Consistent MariaDB plus blob/export backup, checksum verification, destructive restore guard, and restore-drill documentation
- GitHub CI for TypeScript, Playwright, MariaDB, audits, and container builds; tag releases publish multi-architecture SBOM/provenance images signed with keyless Cosign
- Limited live validation dataset from the first Harry Potter search-results page
- Single- and multi-chapter live page-shape support
- Passing TypeScript, MariaDB, and OTW/Rails integration tests

Not yet implemented:

- API live-event stream and detailed failure/export screens
- API authentication and asynchronous large-range discovery/export jobs
- Automated OTW package import-status tracking
- Comments and embedded-asset capture
- A production installer/upgrade strategy for the OTW fork

## Transfer package

A package is a directory containing:

```text
manifest.json
works.jsonl
chapters.jsonl
authors.jsonl
work-authors.jsonl
tags.jsonl
work-tags.jsonl
series.jsonl
series-works.jsonl
observations.jsonl
checksums.sha256
```

JSONL allows both TypeScript and Ruby to process large batches without loading an entire corpus into memory. Packages should normally contain a bounded batch, such as 100–500 works.

## TypeScript development

Requirements: Node.js 20+ and npm 10+.

```bash
npm install
npm run check
npm run package:sample -- fixtures/my-package
npm run package:verify -- fixtures/my-package
```

The committed `fixtures/package-v1` was generated by the TypeScript CLI and is used as the cross-language OTW importer fixture.

## Limited live validation dataset

With operator approval, the first page of AO3 search results for `Harry Potter` was captured once using a 10-second minimum delay, adult-content acceptance, and a 25-request run budget. The page contained 20 work IDs. Eighteen work responses were captured and now parse offline into a verified package containing 18 works, 79 chapters, 15 public source identities, 203 unique tags, and one series. Two requests returned transient HTTP 525 responses and were not retried again after the dataset run.

The private raw dataset is under `datasets/harry-potter-page-1` and is intentionally ignored by Git because it contains full work text. Parser development can now use those local files without further AO3 traffic. A sanitized single-chapter structural fixture was added to the committed test suite.

Default source policy is now configurable and initially set to:

- 10-second minimum delay
- 250 requests/day
- 25 requests per manually initiated validation run
- Adult-content interstitial acceptance enabled
- One request at a time

A real team contact address is still required before routine collector operation.

## Collector database

The collector uses MariaDB/MySQL via `mysql2` and Drizzle. Its database is separate from OTW Archive even if both eventually share a MariaDB server.

```bash
cp env.example .env
docker compose up -d collector-db
export COLLECTOR_DATABASE_URL=mysql://collector:collector_local_only@localhost:3307/ao3_collector
npm run db:migrate
```

See `docs/DATABASE.md` for the schema, isolation rules, and version policy. If you are new to Docker, follow `docs/DOCKER_SETUP.md` from installation through database migration and backups. Use `docs/OPERATIONS.md` for tested API, source, job, and worker commands. The generated migrations and transactional repository tests have been executed successfully against MariaDB 10.11 in Docker.

## Installing the importer into an OTW checkout

The current importer is an overlay for development. Apply it to a disposable OTW checkout:

```bash
chmod +x scripts/install-into-otw.sh
./scripts/install-into-otw.sh ../otwarchive
```

Then, inside the configured OTW development/test environment:

```bash
bin/rails db:migrate
PRESERVATION_FIXTURE_PACKAGE=/absolute/path/to/fixtures/package-v1 \
PRESERVATION_UPDATE_FIXTURE_PACKAGE=/absolute/path/to/fixtures/package-v1-update \
  bundle exec rspec \
  spec/services/preservation_import/package_reader_spec.rb \
  spec/services/preservation_import/runner_spec.rb
```

Import a package:

```bash
PACKAGE=/absolute/path/to/package \
ARCHIVIST=offline_importer \
bundle exec rake preservation:import
```

The importer deliberately sets imported works to restricted in this first private/offline slice. Outbound email should also be disabled at the OTW deployment level.

## Import behavior

- Package ID prevents applying the same completed package twice.
- `(preservation_source, source_work_id)` identifies a work across packages.
- Work hash skips unchanged works.
- `(work link, source_chapter_id)` identifies chapters.
- Rails models and tag setters are used instead of direct content-table SQL.
- A locked local archivist pseud satisfies OTW ownership requirements.
- Public source identities are stored separately and replace the displayed/indexed byline through a small OTW extension.
- Source emails are neither required nor invented.

## Testing status

`npm run check` currently compiles the TypeScript project and executes tests covering:

- Valid package round trip
- Checksum tampering
- Dangling references
- Manifest count mismatches and package lineage
- Deterministic JSONL output
- Entire-work HTML extraction
- Missing-content parser failures
- Cross-origin request rejection
- Serialized request spacing
- `Retry-After` handling
- Response-size limits
- Bounded ID-range planning
- Raw HTML compression and content-addressed deduplication
- Work-task snapshot/parse/persist ordering
- Not-found observations and parser-failure snapshot retention
- Exclusive multi-worker claims and lease ownership
- Heartbeats and expired-lease recovery
- Pause, resume, cancel, and transactional job counters
- Concurrent distributed source-slot reservations and daily-budget enforcement
- Worker scheduling, byte accounting, retry exhaustion, and graceful task outcomes
- Local fixture HTTP source through worker, raw storage, MariaDB, and package export
- Snapshot/incremental package lineage and unchanged-work exclusion
- Fastify route validation, health checks, job controls, and source safety defaults

Database integration has been exercised against MariaDB 10.11: all migrations ran successfully and six integration tests cover durable task idempotency, exclusive leases, budget serialization, recovery, a local fixture-to-worker pipeline, transactional normalization, and incremental package export.

The OTW importer has also been installed into the reference OTW checkout and run in its Docker test environment. Its migration succeeded against MariaDB, and the package reader/importer suite passes with **6 examples and 0 failures**, covering initial import, package idempotency, package ordering, source identities, chapters, tags, series, and incremental updates. Elasticsearch required a low-memory Compose override in this 2 GB sandbox.

## Next steps

1. Add production metrics/alerting and scheduled restore drills.
2. Add optional comments and embedded-asset capture policies.
3. Prepare the first versioned release after repository ownership and registry names are chosen.

The detailed roadmap is maintained in `docs/NEXT_STEPS.md`.
