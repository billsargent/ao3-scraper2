# OTW Archive (deferred / optional)

The private OTW Archive is **not part of the default install**. The collector produces verified transfer packages that are ready to import, and the OTW importer overlay is preserved in this repository under `otw-importer/` for when you want it. Everything on this page is the future, opt-in path.

## Why it is deferred

The OTW Archive (the Rails application that powers AO3) is a much heavier deployment: Rails, MariaDB, Redis, Memcached, and Elasticsearch. The core collector is self-contained and does not need any of it — transfer packages are the boundary between the two applications.

## What it would add

- Native OTW work/chapter/tag/series pages at `http://localhost:3000`
- Idempotent import of verified packages via the Rails `preservation:import` task
- Source-identity bylines without fake emails or local user accounts
- Import-status tracking reported back to the collector

## How to enable it later

```bash
npm run setup -- --with-otw                    # also configures .env.otw-private + builds OTW
bash scripts/all-services.sh start otw         # start the OTW stack
bash scripts/otw-private-import.sh <package-directory>   # import a verified package
```

The importer overlay lives in `otw-importer/`. `scripts/otw-private-*.sh` and `scripts/install-into-otw.sh` handle the persistent OTW lifecycle (up, down, import, backup, restore) against a sibling `otwarchive` checkout. `scripts/all-services.sh` also accepts an explicit `otw` scope.

## Import behavior (for reference)

- Package ID prevents applying the same completed package twice.
- `(preservation_source, source_work_id)` identifies a work across packages.
- Work hash skips unchanged works; `(work link, source_chapter_id)` identifies chapters.
- Rails models and tag setters are used instead of direct content-table SQL.
- Imported works default to **restricted**; source emails are never required or invented.
- A run is `completed` only when every work succeeds; otherwise it stays `partial` and can be retried.
