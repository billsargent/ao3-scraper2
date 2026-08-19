# AO3 Off-site Pipeline (Archive Relay)

A private, offline pipeline that conservatively collects public AO3 work data and packages it for a self-hosted OTW Archive. The production runtime is a **single Docker container** running MariaDB, the Fastify API (which serves the React UI and `/api` on one port), and three workers.

> New operator? Start with [Getting started](docs/GETTING_STARTED.md).

## Quick start

```bash
npm install
npm run setup      # first-time: secrets, build, tests, image, start
npm start          # start the collector afterwards
```

Open `http://localhost:8080` and enter `API_TOKEN` from `.env.production` at the unlock screen.

## Everyday commands

| Command | Purpose |
|---|---|
| `npm start` / `npm stop` / `npm run restart` | Container lifecycle |
| `npm run status` / `npm run logs` | Health and logs |
| `npm run backup` | Consistent backup |
| `npm run reset` | Destructive reset (`CONFIRM_RESET=ERASE_ALL`) |
| `npm run dev` | API + workers + UI locally (development) |
| `npm run check` / `npm test` / `npm run test:e2e` | Tests |

## How it works

1. **Plan** — an ID-range job is expanded durably by the planner worker.
2. **Collect** — the collector worker politely fetches public work pages (one request at a time, 10-second minimum delay, daily budgets, paused by default) and stores raw HTML + normalized records in MariaDB.
3. **Export** — the export worker builds verified snapshot/incremental transfer packages (JSONL + SHA-256 manifest, `.tar.gz`).
4. **Import (optional, future)** — verified packages can later be imported into a private OTW Archive; see [OTW Archive](docs/OTW_ARCHIVE.md).

The collector and OTW Archive never share a database — transfer packages are the only boundary.

## Transfer package

A package is a directory with `manifest.json`, `works.jsonl`, `chapters.jsonl`, `authors.jsonl`, `work-authors.jsonl`, `tags.jsonl`, `work-tags.jsonl`, `series.jsonl`, `series-works.jsonl`, `observations.jsonl`, and `checksums.sha256`. JSONL lets both TypeScript and Ruby stream large batches without loading a corpus into memory. Packages normally hold a bounded batch (100–500 works).

## Repository layout

- `packages/contracts` — versioned transfer-package contract (Zod)
- `packages/scraper-core` — AO3 HTML parser + polite source client
- `packages/collector` — durable worker/planner/export engine
- `packages/database` — Drizzle schema + migrations
- `apps/api` — Fastify control API
- `apps/web` — React/Vite operator interface
- `apps/*-worker` — collector, planner, and export worker processes
- `otw-importer/` — deferred OTW Rails importer overlay (opt-in)

## Documentation

- [Getting started](docs/GETTING_STARTED.md)
- [Operations](docs/OPERATIONS.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Database](docs/DATABASE.md)
- [Backup and restore](docs/BACKUP_RESTORE.md)
- [Testing](docs/TESTING.md)
- [OTW Archive (deferred)](docs/OTW_ARCHIVE.md)
