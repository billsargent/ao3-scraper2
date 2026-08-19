# Collector database

> **Working directory:** Unless a section explicitly says otherwise, run commands from the `ao3-offsite-pipeline` repository root.

The collector uses MariaDB 10.11 via `mysql2` and Drizzle. In production it runs **inside** the collector container on `127.0.0.1:3306` and is not exposed to the host. In development it runs as the `collector-db` service of `docker-compose.yml`, mapped to host port `3307`.

## Isolation

The collector must never write to OTW Archive's database. Keep separate databases and users even if both databases eventually share one MariaDB server:

```text
collector user -> ao3_collector only
otw user       -> otw_archive only
```

Transfer packages and the Rails importer are the boundary between the applications.

## Local development database

```bash
docker compose up -d collector-db
export COLLECTOR_DATABASE_URL='mysql://collector:collector_local_only@localhost:3307/ao3_collector'
npm run db:migrate
```

## Schema groups

- Control plane: `sources`, `collection_jobs`, `collection_tasks`, `export_runs`
- Normalized archive: `works`, `chapters`, `authors`, `work_authors`, `tags`, `work_tags`, `series`, `series_works`
- History/raw capture: `observations`, `fetch_snapshots`

Large HTML fields are `LONGTEXT`. Identifiers use unsigned `BIGINT`; source identities have unique compound indexes. Data is stored as `utf8mb4`.

## Migration policy

Migrations are generated under `packages/database/drizzle`. Once a migration has been used on a shared database, do not rewrite it — generate a new one. In production the API applies migrations automatically on startup.

## Next

- [Operations](OPERATIONS.md)
- [Backup and restore](BACKUP_RESTORE.md)
