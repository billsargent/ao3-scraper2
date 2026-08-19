# Persistent private OTW Archive

> **Working directory:** Unless a section explicitly says otherwise, run commands from the `ao3-offsite-pipeline` repository root.
>
> ```bash
> cd /path/to/ao3-offsite-pipeline
> ```

The disposable test environment is not the persistent archive. This profile keeps OTW MariaDB volumes and imported records between restarts.

## Configure and start

```bash
cp env.otw-private.example .env.otw-private
# Set a strong OTW_ARCHIVIST_PASSWORD
npm run otw:up
```

Defaults bind OTW only to `127.0.0.1:3000`, disable outbound email, add `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`, and mark work responses private/no-store. Put it behind authenticated private networking before changing the bind address.

The setup creates or updates a dedicated `offline_importer` user with the OTW archivist role. Low-memory mode uses a 128 MB Elasticsearch heap and leaves Resque disabled. Set `OTW_ENABLE_RESQUE=true` only on a host with enough RAM; without it, background indexing/email queues are not processed, but imported work and chapter pages remain available.

## Import a verified package

```bash
npm run otw:import -- datasets/harry-potter-page-1/package
```

The importer is idempotent and retries partial imports. It normalizes AO3's “Creator Chose Not To Use Archive Warnings” label to OTW's canonical warning. A run is `completed` only when every work succeeds; otherwise it remains `partial` and can be retried.

Optional collector callbacks:

```dotenv
COLLECTOR_CALLBACK_URL=http://host.docker.internal:3001/
COLLECTOR_API_TOKEN=<collector bearer token>
```

## Stop without deleting data

```bash
npm run otw:down
```

Do not add `-v`; OTW MariaDB is stored in Docker volumes.

## Backup and restore

```bash
npm run otw:backup

CONFIRM_RESTORE=yes \
  ./scripts/otw-private-restore.sh backups/otw/<timestamp>
```

Backups contain OTW MariaDB, local uploads/storage, `public/system`, local branding/config, metadata, and checksums. Keep credentials separately in encrypted storage.

## Current validated batch

The 18-work Harry Potter validation package imports as:

```text
Works:    18
Chapters: 79
Series:   1
Failed:   0
```

The archive remains private and is not a replacement for AO3's own backups.
