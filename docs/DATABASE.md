# MariaDB/MySQL collector database

The collector now targets MySQL-compatible databases through `mysql2` and Drizzle. MariaDB is the development default because OTW Archive already uses the MySQL protocol and MariaDB in its own deployment.

## Isolation

The collector must not write to OTW Archive's database. Use separate databases and users even when both databases share one server:

```text
collector user -> ao3_collector only
otw user       -> otw_archive only
```

Transfer packages and the Rails importer are the boundary between the applications.

## Local database

```bash
cp .env.example .env
# Export COLLECTOR_DATABASE_URL from .env in your shell or process manager.
docker compose up -d collector-db
npm run db:migrate -w @ao3-offsite/database
```

The generated migration has been executed successfully against the provided MariaDB 10.11 container. Integration tests also verified idempotent durable-task creation and transactional work/chapter/tag/series reconciliation.

## Schema groups

- Control plane: `sources`, `collection_jobs`, `collection_tasks`
- Normalized archive: `works`, `chapters`, `authors`, `work_authors`, `tags`, `work_tags`, `series`, `series_works`
- History/raw capture: `observations`, `fetch_snapshots`

Large HTML fields are `LONGTEXT`. All identifiers use unsigned `BIGINT`. Source identities have unique compound indexes. MariaDB receives UTF-8 data as `utf8mb4`.

## Migration policy

The initial SQL migration is generated under `packages/database/drizzle`. Once a migration has been used on a shared database, do not rewrite it; generate a new migration.

For production, pin and test one MariaDB/MySQL version. The development default is MariaDB 10.11 LTS rather than the old MariaDB 10.5 image in the reference OTW checkout. OTW's complete test suite must pass against the selected shared-server version before consolidating both databases onto one server.
