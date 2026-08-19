# Backup and restore

> **Working directory:** Unless a section explicitly says otherwise, run commands from the `ao3-offsite-pipeline` repository root.

## Create a backup

```bash
npm run backup
```

This dumps MariaDB (a consistent `--single-transaction` snapshot) and archives blobs/exports into:

```text
backups/<UTC timestamp>/
├── collector.sql.gz
├── data.tar.gz
├── metadata.txt
└── checksums.sha256
```

Optional `.env.production` settings:

```dotenv
BACKUP_DIR=./backups
BACKUP_RETENTION_DAYS=30
```

Copy completed backup directories to at least one other physical location. The production environment file is deliberately excluded; store its credentials separately in encrypted form.

## Verify

```bash
cd backups/<timestamp>
sha256sum -c checksums.sha256
gzip -t collector.sql.gz
tar -tzf data.tar.gz >/dev/null
```

## Restore

Restoration is destructive:

```bash
CONFIRM_RESTORE=yes \
  ./scripts/restore-production.sh backups/<timestamp>
```

The script:

1. Verifies backup checksums.
2. Ensures the collector container is running.
3. Drops and recreates the collector database.
4. Imports the logical SQL dump.
5. Replaces raw blob and export data.
6. Restarts the collector so the API re-runs migrations and workers reconnect.

## Restore drill

Run a drill on a separate host or with a separate `.env.production` and project name. Verify:

- API readiness
- Source remains paused when expected
- Work and chapter counts
- A sample offline chapter
- Raw snapshot paths
- Export package checksum/download
- Planner/export queues

A backup is not considered proven until a restore drill succeeds.

## OTW Archive

This backup covers the collector only. The OTW side (if/when enabled) is backed up separately: its MariaDB database, uploads/storage, configuration, and importer provenance tables. Elasticsearch, Redis, and caches are rebuilt from authoritative data. See [OTW Archive](OTW_ARCHIVE.md).
