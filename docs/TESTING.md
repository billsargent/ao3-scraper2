# Testing guide

## Fast local checks

```bash
npm install
npm run check
npm run web:build
npm audit --omit=dev
```

## MariaDB integration

```bash
docker compose up -d --wait collector-db
export COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'
npm run db:migrate
npm test -- --run packages/collector/test/store.integration.test.ts
```

The integration suite exercises migrations, task leases, request budgets, planning recovery, worker persistence, concurrent export workers, sequence/parent lineage, archive creation, and checksum verification. It resets collector tables, so do not point it at a database containing data you need.

## Browser tests

Install Chromium once:

```bash
npx playwright install --with-deps chromium
```

Run:

```bash
npm run test:e2e
```

Playwright starts a Vite server and intercepts API calls with deterministic fixtures. It does not contact AO3 or require MariaDB. Current scenarios cover:

- Operator token unlock
- Durable ID-range job creation and cancellation
- Browser ID and granular source policy
- Server-paginated work list
- Offline work/chapter reader
- Package manifest and hash inspection
- Authenticated `.tar.gz` download
- OTW import-status action

## Full collector-to-OTW pipeline

Run the complete disposable integration path with one command:

```bash
npm run test:full-pipeline
```

Optional environment variables:

```bash
OTW_DIR=/path/to/otwarchive
SKIP_FAST_CHECKS=true
KEEP_OTW_CONTAINERS=true
```

The command:

1. Starts collector MariaDB and applies migrations.
2. Parses a local AO3-shaped fixture without network access.
3. Persists native collector records.
4. Creates and verifies a transfer package through the export queue.
5. Installs the importer overlay into a disposable OTW checkout.
6. Starts low-memory MariaDB, Redis, Memcached, and Elasticsearch for OTW.
7. Resets and seeds the OTW test database.
8. Imports the generated collector package.
9. Verifies native OTW works, chapters, tags, source identities, and series.
10. Runs package-reader, callback, idempotency, and incremental-update specs.

The script cleans up OTW containers unless `KEEP_OTW_CONTAINERS=true`; named volumes remain. It must never target an important OTW database.

Latest sandbox result: **9 RSpec examples, 0 failures**, ending with `FULL PIPELINE PASSED`.
