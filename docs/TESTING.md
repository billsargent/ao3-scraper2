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

## OTW importer

Follow `docs/DOCKER_SETUP.md` for the disposable low-memory OTW environment. Run the package reader, collector notifier, and importer specs together. Never run reset/migration test scripts against an important OTW database.
