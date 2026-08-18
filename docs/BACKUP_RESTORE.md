# Backup and restore

## Create a consistent backup

```bash
./scripts/backup-production.sh
```

The script briefly stops API/web/workers, keeps MariaDB running, then creates:

```text
backups/<UTC timestamp>/
├── collector.sql.gz
├── data.tar.gz
├── metadata.txt
└── checksums.sha256
```

Application services restart automatically, including after most failures.

Optional configuration in `.env.production`:

```dotenv
BACKUP_DIR=./backups
BACKUP_RETENTION_DAYS=30
```

Copy completed backup directories to at least one different physical location. The production environment file is deliberately excluded; store its credentials separately in encrypted form.

## Verify

```bash
cd backups/20260818T120000Z
sha256sum -c checksums.sha256
gzip -t collector.sql.gz
tar -tzf data.tar.gz >/dev/null
```

## Restore

Restoration is destructive:

```bash
CONFIRM_RESTORE=yes \
  ./scripts/restore-production.sh backups/20260818T120000Z
```

The script:

1. Verifies backup checksums.
2. Stops application services.
3. Drops and recreates the collector database.
4. Imports the logical SQL dump.
5. Replaces raw blob and export data.
6. Starts services and applies any newer migrations.

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

This backup covers the collector only. Back up the OTW deployment separately: its MariaDB database, uploads/storage, configuration, and importer provenance tables. Elasticsearch, Redis, and caches should be rebuilt from authoritative data.
