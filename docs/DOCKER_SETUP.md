# Beginner Docker setup guide

Docker is a development and testing convenience for this project. You do not need to understand Docker internals to run the provided commands.

## What Docker will run

For the current collector phase, Docker runs one service:

- `collector-db`: MariaDB for the TypeScript collector

Later, the OTW Archive test environment will also run MariaDB, Redis, Elasticsearch, Memcached, Rails, and a test browser. Those services are defined by OTW Archive's own Docker configuration.

The project source remains in your normal filesystem. Database data is stored in a named Docker volume and survives ordinary container restarts.

---

## 1. Install Docker

### Windows 10/11

1. Install all pending Windows updates.
2. Install Docker Desktop from <https://www.docker.com/products/docker-desktop/>.
3. During installation, enable the WSL 2 backend when offered.
4. Restart Windows if requested.
5. Start Docker Desktop and wait until it reports that the engine is running.
6. Open PowerShell and verify:

```powershell
docker version
docker compose version
```

Run project commands from a WSL terminal when possible. Keeping the repository inside the WSL filesystem generally performs better than mounting it from `C:\`.

### macOS

1. Install Docker Desktop from <https://www.docker.com/products/docker-desktop/>.
2. Choose the Apple Silicon build for M-series Macs or Intel build for older Macs.
3. Start Docker Desktop.
4. Open Terminal and verify:

```bash
docker version
docker compose version
```

### Ubuntu/Debian Linux

Use Docker's official installation instructions for your distribution: <https://docs.docker.com/engine/install/>.

After installing Docker Engine and the Compose plugin, optionally allow your normal user to invoke Docker without `sudo`:

```bash
sudo usermod -aG docker "$USER"
```

Log out and back in before testing:

```bash
docker version
docker compose version
```

Membership in the `docker` group is effectively administrative access to the machine. Do this only on a machine you control.

---

## 2. Verify prerequisites

From a terminal in the project directory:

```bash
node --version
npm --version
docker version
docker compose version
```

Expected minimums:

- Node.js 20 or newer
- npm 10 or newer
- A current Docker Engine/Desktop release
- Docker Compose v2 (`docker compose`, with a space)

Docker Desktop should be running before executing Compose commands.

---

## 3. Configure the project

From the `ao3-offsite-pipeline` directory:

```bash
cp .env.example .env
npm install
```

The default `.env` values are for local development only. They expose MariaDB on host port `3307` so they do not conflict with a normal MySQL installation using port `3306`.

Do not commit `.env`; it is intentionally ignored by Git.

---

## 4. Start MariaDB

```bash
docker compose up -d collector-db
```

The first run downloads the MariaDB image and may take several minutes. Check its status:

```bash
docker compose ps
```

Wait until `collector-db` reports `healthy`. To watch startup logs:

```bash
docker compose logs -f collector-db
```

Press `Ctrl+C` to stop following logs; this does not stop MariaDB.

---

## 5. Apply the collector schema

Load environment variables in your shell or set the database URL directly.

### macOS/Linux/WSL

```bash
export COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'
npm run db:migrate
```

### Windows PowerShell

```powershell
$env:COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'
npm run db:migrate
```

Then run the tests:

```bash
npm run check
```

At this point the collector database is running, migrated, and ready for database integration tests.

---

## 6. Common Docker commands

### Show running project services

```bash
docker compose ps
```

### View MariaDB logs

```bash
docker compose logs collector-db
```

### Stop services but keep database data

```bash
docker compose stop
```

### Start stopped services

```bash
docker compose start
```

### Stop and remove containers but keep database data

```bash
docker compose down
```

### Delete containers and all collector database data

```bash
docker compose down -v
```

The `-v` command is destructive. It deletes the `collector-mariadb` volume and all collector data. Do not use it on a database you intend to keep.

### Update the MariaDB image

```bash
docker compose pull collector-db
docker compose up -d collector-db
```

Do not change major MariaDB versions without taking a database backup and testing the upgrade.

---

## 7. Inspect MariaDB manually

Open a MariaDB command-line session inside the container:

```bash
docker compose exec collector-db \
  mariadb -ucollector -pcollector_local_only ao3_collector
```

Useful read-only commands:

```sql
SHOW TABLES;
SELECT COUNT(*) FROM works;
SELECT COUNT(*) FROM collection_jobs;
EXIT;
```

Avoid manually changing rows. Collector migrations and application code should own the schema and data.

---

## 8. Back up the collector database

Create a logical SQL backup:

```bash
mkdir -p backups
docker compose exec -T collector-db \
  mariadb-dump -ucollector -pcollector_local_only \
  --single-transaction --routines --triggers ao3_collector \
  > backups/ao3_collector.sql
```

Restore into an empty local collector database:

```bash
docker compose exec -T collector-db \
  mariadb -ucollector -pcollector_local_only ao3_collector \
  < backups/ao3_collector.sql
```

Raw HTML blobs under the configured blob directory must be backed up separately. A database dump alone does not contain blob files.

---

## 9. OTW Archive testing

OTW Archive has its own `docker-compose.yml` and initialization scripts. The planned test sequence is:

1. Keep `ao3-offsite-pipeline` and `otwarchive` as sibling directories.
2. Apply the importer overlay to the disposable OTW checkout:

```bash
cd ao3-offsite-pipeline
./scripts/install-into-otw.sh ../otwarchive
```

3. Initialize OTW using the instructions in its repository:

```bash
cd ../otwarchive
script/docker/init.sh
```

4. Run only the importer specs first:

```bash
docker compose run --rm \
  -e PRESERVATION_FIXTURE_PACKAGE=/pipeline/fixtures/package-v1 \
  -e PRESERVATION_UPDATE_FIXTURE_PACKAGE=/pipeline/fixtures/package-v1-update \
  test bundle exec rspec \
  spec/services/preservation_import/package_reader_spec.rb \
  spec/services/preservation_import/runner_spec.rb
```

The fixture paths must be mounted into the OTW test container. The OTW Compose file does not yet contain that mount; the project will add a dedicated integration Compose override before this command is considered ready to copy and run unchanged.

Do not initialize OTW against an important existing database. Use a disposable development/test environment.

---

## 10. Troubleshooting

### `docker: command not found`

Docker is not installed or your terminal was opened before installation completed. Install/start Docker Desktop or Docker Engine, then open a new terminal.

### `Cannot connect to the Docker daemon`

Docker Desktop is not running, the Linux daemon is stopped, or your user lacks permission.

Docker Desktop: start the application and wait for it to report ready.

Linux:

```bash
sudo systemctl status docker
sudo systemctl start docker
```

### Port 3307 is already in use

Change `COLLECTOR_DATABASE_PORT` in `.env`, for example:

```dotenv
COLLECTOR_DATABASE_PORT=3308
COLLECTOR_DATABASE_URL=mysql://collector:collector_local_only@localhost:3308/ao3_collector
```

Recreate the container:

```bash
docker compose down
docker compose up -d collector-db
```

### MariaDB is unhealthy

Inspect logs:

```bash
docker compose logs collector-db
```

A first startup can take longer on a slow disk. If this is an expendable new database and initialization was interrupted, reset it with:

```bash
docker compose down -v
docker compose up -d collector-db
```

Remember that `-v` deletes existing collector data.

### Apple Silicon image problems

The official MariaDB image supports common ARM64 Macs. OTW's full environment may contain dependencies with architecture-specific behavior; report the exact failing image and log before changing platform settings.

---

## Security notes

- The example passwords are intentionally only for a local development machine.
- Do not expose port 3307 to the public internet.
- Use different strong credentials in any shared or production deployment.
- Do not mount the Docker socket into application containers.
- Do not run untrusted images or Compose files.
- Back up both MariaDB and raw blob/package storage.
