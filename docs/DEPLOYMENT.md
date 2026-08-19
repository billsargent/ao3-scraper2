# Production deployment

> **Working directory:** Unless a section explicitly says otherwise, run commands from the `ao3-offsite-pipeline` repository root.
>
> ```bash
> cd /path/to/ao3-offsite-pipeline
> ```

This profile runs the collector control plane. OTW Archive remains a separate deployment and receives verified transfer packages.

## Requirements

- Linux host or VM with Docker Engine and Compose v2
- 2 CPU cores minimum; 4 recommended
- 4 GB RAM minimum for collector services
- Storage sized for MariaDB plus raw HTML and export packages
- TLS reverse proxy or private VPN if accessed beyond localhost

## Configure

```bash
cp env.production.example .env.production
openssl rand -hex 32
```

Edit every `change-me` value. `COLLECTOR_DATABASE_PASSWORD` must be URL-safe because it appears in `COLLECTOR_DATABASE_URL`. Set `APP_UID` and `APP_GID` to the host account that owns `DATA_DIR` (usually `id -u` and `id -g`; both are commonly 1000). Keep `.env.production` outside source control and back it up separately in a password manager or encrypted secrets store.

The AO3 source is created paused. Review Browser ID, delay, request/byte budgets, operating window, and job range before enabling it.

## Start

Collector only:

```bash
./scripts/production-up.sh
```

Collector and private OTW together:

```bash
bash scripts/all-services.sh start all
```

Stop or inspect the complete stack:

```bash
bash scripts/all-services.sh status all
bash scripts/all-services.sh stop all
```

Open `http://localhost:8080` by default. Enter `API_TOKEN` at the unlock screen.

Services:

- `collector-db` — MariaDB
- `api` — Fastify, migrations, downloads, SSE
- `collector-worker` — source fetch/parse/persist
- `planner-worker` — durable range expansion
- `export-worker` — verified package generation
- `web` — Nginx and static Vite interface

Every long-lived service uses `restart: unless-stopped`, bounded JSON logs, health checks where applicable, and one init process for signal handling. The API runs migrations before accepting traffic.

## Inspect

```bash
docker compose --env-file .env.production -f compose.production.yml ps
docker compose --env-file .env.production -f compose.production.yml logs -f --tail=200
docker compose --env-file .env.production -f compose.production.yml logs -f collector-worker
```

## Stop or update

```bash
./scripts/production-down.sh

git pull
./scripts/production-up.sh
```

Take a backup before updating. Do not use `docker compose down -v`; it deletes MariaDB.

## Network security

Only the Nginx web port is published. MariaDB and Fastify remain on the internal Compose network. For remote access, place port 8080 behind HTTPS and additional network access control. The bearer token protects the API but is not a substitute for TLS.

## Data paths

- MariaDB: Docker volume `archive-relay_collector-mariadb`
- Raw responses: `${DATA_DIR}/blobs`
- Transfer packages: `${DATA_DIR}/exports`

Back up both MariaDB and `DATA_DIR`; neither is sufficient alone.
