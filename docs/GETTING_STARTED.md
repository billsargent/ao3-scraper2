# Getting started

> **Working directory for every command in this guide:** the `ao3-offsite-pipeline` repository root.

Archive Relay collects public AO3 works conservatively, stores them in its own MariaDB, and produces verified transfer packages you can later import into a private OTW Archive. The production runtime is a **single Docker container** that runs everything: MariaDB, the Fastify API (which serves both the React UI and the `/api` routes on one port), and the three workers.

## Prerequisites

- Node.js 20+ and npm 10+
- Docker Engine / Docker Desktop with Compose v2 (`docker compose`, with a space)

Verify:

```bash
node --version
npm --version
docker version
docker compose version
```

Windows: install Docker Desktop with the WSL 2 backend. Keeping the project inside the WSL filesystem generally performs better than mounting it from `C:\`.

## First-time setup (one command)

```bash
npm install
npm run setup
```

`npm run setup`:

1. Creates `.env.production` with generated secrets (database passwords, API token).
2. Installs and builds the Node workspace and the React UI.
3. Runs the test suite.
4. Builds the single collector Docker image.
5. Starts the collector.

Open `http://localhost:8080`. If you configured an `API_TOKEN` in `.env.production`, enter it at the unlock screen. For a trusted local-only deployment you can leave `API_TOKEN` empty (e.g. `npm run setup -- --no-api-token`) and the dashboard loads directly.

> The collector source is created **paused**. Nothing is requested from AO3 until you create a job, review the source policy, and enable the source.

## Everyday commands

| Command | What it does |
|---|---|
| `npm start` | Start the collector container |
| `npm stop` | Stop it |
| `npm run restart` | Restart it |
| `npm run status` | Show container status |
| `npm run logs` | Follow container logs |
| `npm run backup` | Consistent backup (database + data) |
| `npm run reset` | Destructive reset (requires `CONFIRM_RESET=ERASE_ALL`) |
| `npm run dev` | Run API + workers + UI locally in one terminal (development) |

## Where things live

- MariaDB data: Docker volume `archive-relay_collector-mariadb`
- Raw HTML blobs: `${DATA_DIR}/blobs` (default `./data/blobs`)
- Transfer packages: `${DATA_DIR}/exports` (default `./data/exports`)
- Backups: `${BACKUP_DIR}` (default `./backups`)

Only port `8080` is exposed to the host. MariaDB listens on `127.0.0.1` inside the container and is not reachable from outside.

## Development mode (optional)

For iterating on code without the container:

```bash
docker compose up -d collector-db
export COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'
npm run db:migrate
npm run dev
```

Open the Vite UI at `http://localhost:5173`; it proxies `/api` to the local API on `127.0.0.1:3001`.

## Next

- [Using the UI](USING_THE_UI.md) — the operator interface at a glance
- [Operations](OPERATIONS.md) — sources, jobs, packages, monitoring, troubleshooting
- [Deployment](DEPLOYMENT.md) — configuration, upgrades, security, releases
- [Database](DATABASE.md) — schema and migration policy
- [Backup and restore](BACKUP_RESTORE.md)
- [Testing](TESTING.md)
- [OTW Archive (deferred / optional)](OTW_ARCHIVE.md)
