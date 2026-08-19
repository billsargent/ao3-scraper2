# Testing

> **Working directory:** Unless a section explicitly says otherwise, run commands from the `ao3-offsite-pipeline` repository root.

## Fast local checks

```bash
npm install
npm run check
npm run web:build
npm audit --omit=dev
```

`npm run check` builds the TypeScript project and runs the unit/API tests.

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
- Explanatory field-level validation errors
- Job pause/resume controls
- Server-paginated work list
- Offline creators, series, tags, and chapter reader
- Package manifest and hash inspection
- Authenticated `.tar.gz` download
- OTW import-status action

## Full collector-to-OTW pipeline (optional)

The end-to-end proof (fixture → MariaDB → verified package → native OTW records) is available once the OTW side is enabled:

```bash
npm run test:full-pipeline
```

It requires the OTW setup from [OTW Archive](OTW_ARCHIVE.md) (`npm run setup -- --with-otw`). Without OTW configured, the collector half of the pipeline is covered by the integration suite above.
