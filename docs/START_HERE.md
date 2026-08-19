# Start here

> **Working directory for every command in this guide:** the `ao3-offsite-pipeline` repository root.
>
> ```bash
> cd /path/to/ao3-offsite-pipeline
> ```

Archive Relay has two cooperating applications:

- **Collector UI** — controls jobs, stores raw/normalized data, and creates verified packages.
- **Private OTW Archive** — imports those packages and displays native OTW work pages.

They use separate databases. The collector never writes directly to OTW tables.

For all ports and Raspberry Pi guidance, see [`PORTS_AND_HARDWARE.md`](PORTS_AND_HARDWARE.md).

---

## First-time setup: one command

Docker and npm must already work:

```bash
node --version
npm --version
docker version
docker compose version
```

Build, configure, test, and start everything:

```bash
npm run setup:all -- --start
```

The first OTW image build can take several minutes.

The setup script:

1. Generates database passwords, API token, and OTW archivist password.
2. Creates `.env.production` and `.env.otw-private`.
3. Installs and builds the Node workspace.
4. Runs tests.
5. Builds collector and OTW images.
6. Installs the importer into the sibling `otwarchive` checkout.
7. Starts both persistent stacks.

Open:

```text
Collector UI:       http://localhost:8080
Private OTW Archive: http://localhost:3000
```

The API token is in `.env.production`. The OTW login/password are in `.env.otw-private`. Both files are ignored by Git.

The collector source starts **paused**.

---

## Start and stop everything after it has been built

```bash
npm run services:start
npm run services:status
npm run services:stop
```

Other lifecycle commands:

```bash
npm run services:backup
bash scripts/all-services.sh restart all
bash scripts/all-services.sh logs all
```

Limit an action to one stack:

```bash
bash scripts/all-services.sh start collector
bash scripts/all-services.sh stop collector
bash scripts/all-services.sh start otw
bash scripts/all-services.sh stop otw
```

`services:start` does not rerun the setup wizard or regenerate secrets. It starts already-built images. The collector sidebar displays both the UI build commit and API commit; if they differ, rebuild with `npm run production:up` and hard-refresh the browser.

---

## Full destructive reset

This deletes collector and OTW containers, database volumes, raw blobs, generated packages, and private OTW local storage. It does not delete source code, the saved validation dataset, backups, or environment files.

```bash
CONFIRM_RESET=ERASE_ALL npm run services:reset
```

To also delete backups or generated environment files:

```bash
CONFIRM_RESET=ERASE_ALL ERASE_BACKUPS=yes ERASE_CONFIG=yes npm run services:reset
```

Then rebuild from scratch:

```bash
npm run setup:all -- --start
```

Back up first if any data matters.

---

## Load the saved 18-work dataset

The production collector database is separate from the development database. For normal UI evaluation, use the development collector instructions in `OPERATIONS.md`, or import a generated package into OTW directly.

To import the saved package into the persistent private OTW archive:

```bash
npm run otw:import -- datasets/harry-potter-page-1/package
```

Expected result:

```text
Works:    18
Chapters: 79
Series:    1
Failed:    0
```

Imports are idempotent. Re-running the same package skips successful records and retries partial failures.

---

## Run a collection job

1. Open the collector UI at `http://localhost:8080`.
2. Unlock it with `API_TOKEN` from `.env.production`.
3. Open **Source Settings**.
4. Review Browser ID, delay, budgets, timeout, retries, and operating window.
5. Leave the source paused.
6. Create a small range under **Collection Jobs**.
7. Confirm the planned task count.
8. Enable the source only when ready.
9. Monitor progress and failures.
10. Pause the source when the planned run finishes.

Source settings have no configured maximums for delay, request budget, bandwidth, response size, timeout, or retry count. `0` has these meanings:

```text
Minimum delay:       no delay
Daily requests:      unlimited
Daily bandwidth:     unlimited
Maximum response:    unlimited
Request timeout:     disabled
Failure attempts:    unlimited
```

The source remains subject to basic technical constraints such as non-negative whole numbers and database integer storage.

---

## Review collected metadata

Open **Archive Library**, select **View**, and inspect:

- Title and source work ID
- Public creator identities
- Summary and notes
- Rating
- Warnings
- Categories
- Fandoms
- Relationships
- Characters
- Additional/freeform tags
- Series and position
- Chapters and full chapter text

Metadata and tag relationships are stored in MariaDB and included in transfer packages.

---

## Create and import a transfer package

In the collector UI:

1. Open **Transfer Packages**.
2. Select **Queue export**.
3. Wait for `completed`.
4. Open **Inspect**.
5. Review manifest counts, SHA-256, and verification time.
6. Download `.tar.gz`, or use the package directory on the host.

Import a package directory into private OTW:

```bash
npm run otw:import -- data/exports/<package-id>
```

If collector callbacks are configured, OTW reports `importing`, `imported`, or `failed` automatically.

---

## Back up both systems

```bash
npm run services:backup
```

Collector backups go to:

```text
backups/<timestamp>/
```

Private OTW backups go to:

```text
backups/otw/<timestamp>/
```

Keep at least one copy on another physical machine or encrypted remote storage.

Detailed restore commands are in:

- [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md)
- [`PRIVATE_OTW.md`](PRIVATE_OTW.md)

---

## Development mode instead of production mode

Use development mode only when changing code:

```bash
cp env.example .env
npm install
docker compose up -d --wait collector-db
export COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'
npm run db:migrate
```

Use separate terminals:

```bash
npm run api:start
npm run web:dev
npm run planner-worker:start
npm run export-worker:start
```

Development URLs:

```text
UI:       http://localhost:5173
API:      http://localhost:3001
MariaDB:  localhost:3307
```

Start `npm run worker:start` only when intentionally collecting. Source pause is still enforced in MariaDB.

---

## Tests

```bash
npm run check
npm run web:build
npm run test:e2e
npm run docs:verify
```

Full disposable collector-to-OTW proof:

```bash
npm run test:full-pipeline
```

Do not run MariaDB integration/full-pipeline reset tests against important databases.

---

## Troubleshooting

### UI is missing after closing the browser

Closing the browser does not delete data. Restart:

```bash
npm run services:start
```

### Job pause appears ineffective

Refresh the job detail. Pausing now:

- Prevents collector task claims.
- Releases active planning leases.
- Stops the planner from adding another batch.
- Allows an already-running HTTP request to finish.

### `validation_error`

The UI now displays the field name and API explanation. Numeric source controls accept any non-negative whole number; zero disables/unlimits the setting as listed above. Open **Debug log** to see the request path, status, duration, server message, validation issues, and request ID. Download the JSON when asking for support.

### A terminal stays on `otwarchive-web-run-... Created`

First-time OTW database seeding can take several minutes. The current scripts use non-interactive one-off containers and timeouts. `Ctrl+C` should stop the command. From another terminal, run this from the repository root to stop services and remove one-off containers:

```bash
npm run services:stop
```

### OTW search is stale

Low-memory OTW mode defaults to:

```dotenv
OTW_ENABLE_RESQUE=false
```

Work pages remain available, but background indexing is not processed. Enable Resque only on a host with sufficient RAM.

### Need more detail

- Ports/hardware: [`PORTS_AND_HARDWARE.md`](PORTS_AND_HARDWARE.md)
- Production: [`DEPLOYMENT.md`](DEPLOYMENT.md)
- Testing: [`TESTING.md`](TESTING.md)
- Private OTW: [`PRIVATE_OTW.md`](PRIVATE_OTW.md)
- Backup/restore: [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md)

---

## Completion status

The core system is implemented and tested:

```text
collect → raw snapshot → normalize → package → verify → import → browse → back up → restore
```

Remaining work is optional operational enhancement: metrics, scheduled drills, comments, and embedded assets.
