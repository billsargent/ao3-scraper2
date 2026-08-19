# Deployment

> **Working directory:** Unless a section explicitly says otherwise, run commands from the `ao3-offsite-pipeline` repository root.

The production runtime is one container (`collector`) defined by `compose.production.yml`. It runs MariaDB, the Fastify API (UI + `/api` + `/healthz`), and the three workers under `supervisord` in a single process tree.

## Requirements

- Linux host/VM with Docker Engine + Compose v2 (or Docker Desktop)
- 2 CPU cores minimum; 4 recommended
- 4 GB RAM minimum
- Storage for MariaDB plus raw HTML and export packages
- TLS reverse proxy or private network if accessed beyond localhost

## Configuration

```bash
cp env.production.example .env.production
```

Edit every `change-me` value. `COLLECTOR_DATABASE_PASSWORD` must be URL-safe because it appears in `COLLECTOR_DATABASE_URL`. Keep `.env.production` out of source control and back it up separately in a password manager or encrypted store.

| Variable | Purpose |
|---|---|
| `MARIADB_ROOT_PASSWORD` | Root password for the in-container MariaDB |
| `COLLECTOR_DATABASE_NAME` / `_USER` / `_PASSWORD` | Collector database identity |
| `COLLECTOR_DATABASE_URL` | Connection URL (points at `127.0.0.1:3306` inside the container) |
| `API_TOKEN` | Bearer token for the API (also the UI unlock code) |
| `WEB_PORT` | Host port mapped to the container (default `8080`) |
| `APP_VERSION` | Image tag / UI build label |
| `DATA_DIR` | Host directory for blobs and exports |
| `BACKUP_DIR` | Host directory for backups |
| `TZ` | Time zone (default `UTC`) |

MariaDB is **not** exposed to the host; it listens on `127.0.0.1` inside the container.

## Start / stop

```bash
npm start          # build (if needed) + start
npm stop
npm run restart
npm run status
npm run logs
```

The scripts are thin wrappers over `scripts/production-up.sh`, `scripts/production-down.sh`, and `scripts/all-services.sh`. The API applies database migrations before accepting traffic.

## Inspect inside the container

```bash
docker compose --env-file .env.production -f compose.production.yml ps
docker compose --env-file .env.production -f compose.production.yml logs -f --tail=200
docker exec -it <container> supervisorctl status
```

The container name is listed by `docker compose ps` (typically `archive-relay-collector-1`).

## Update

Take a backup first:

```bash
npm run backup
npm stop
```

### Git checkout

```bash
git pull
npm start
```

### Downloaded ZIP

1. `npm run backup` and save `.env.production` separately.
2. `npm stop`.
3. Extract the new ZIP over the project root so `package.json` sits at the root (not in a nested directory).
4. Keep the existing runtime `.env*` files; do not replace them with the examples.
5. `npm start` and hard-refresh the UI (the sidebar shows UI/API build IDs; a ZIP without Git metadata shows a matching `zip-<content-hash>`).

The database volume and `DATA_DIR` survive source overwrites. Do not use `docker compose down -v` (it deletes MariaDB) unless you intend a reset.

## Network security

Only `WEB_PORT` (default `8080`) is published. Put it behind HTTPS/VPN for remote access. The bearer token protects the API but is not a substitute for TLS.

## CI and signed releases

`.github/workflows/ci.yml` runs the TypeScript build plus unit/API tests, the Vite build, Playwright Chromium tests, an npm audit, MariaDB migrations plus the integration suite, and the single container build.

Push a semantic tag to build and publish a multi-arch image with BuildKit provenance, an SBOM, and a keyless Sigstore/Cosign signature:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Verify a published image with `cosign verify` against the tag's OIDC identity. Production Compose builds locally by default; to deploy published images, override `image:` in a small Compose override pinned to immutable digests.

## Data paths

- MariaDB: Docker volume `archive-relay_collector-mariadb`
- Raw responses: `${DATA_DIR}/blobs`
- Transfer packages: `${DATA_DIR}/exports`

Back up both MariaDB and `DATA_DIR`; neither is sufficient alone. See [Backup and restore](BACKUP_RESTORE.md).
