# Using the UI

A tour of the operator interface that the collector serves at `http://localhost:8080`. Everything in the interface is backed by the `/api` routes and reflects data in the collector's MariaDB.

## Unlock

If you configured an `API_TOKEN` in `.env.production`, the UI first shows an **unlock screen** — enter the token once and it is kept in your browser's local storage. If `API_TOKEN` is empty (a trusted local-only deployment), the dashboard loads directly with no unlock.

## Overview (dashboard)

- **Collected works / Archived words** — accurate totals for the whole archive (from `GET /api/statistics`), not just the currently loaded view.
- **Active jobs** — jobs that are queued or running.
- **Terminal failures** — genuine failures (retry-exhausted, parse errors, etc.). Works that return HTTP 404 are counted as **skipped**, not failures.
- **Safety controls** — source state (paused/enabled), minimum delay, daily request cap, plus **Requests today** and **Bandwidth today** vs. your configured caps (from per-source daily usage).
- **Pause / Resume collection** — a one-click kill-switch right on the Overview.
- **New collection job** — opens the job form.

## Collection jobs

- Create an **ID range job**: starting work ID, ending work ID, and batch size. Batch size defaults to the value in **System settings** but can be changed per job.
- Jobs are durable: they survive API/worker restarts, and a source's delay/budget limits apply across every worker.
- Use the row actions to **Pause**, **Resume**, or **Cancel** a job.
- Progress shows `done / total`; not-found works count toward the skipped total.

## Failure review

- Lists `retryable_failed` and `terminal_failed` tasks with the error code and message.
- **HTTP 404 (not found) tasks are not shown here** — for ID-batch jobs those just mean the work is gone, so they are recorded as skipped instead.
- **Retry job failures** re-queues a job's terminal failures for another pass.

## Transfer packages (exports)

- Queue a **snapshot** export with a maximum works bound.
- Inspect a package: status, work count, archive size, SHA-256, verified time, and manifest contents.
- **Download .tar.gz** — the verified transfer package.
- **Re-verify package** — re-hashes the on-disk archive and reports whether it still matches the recorded SHA-256 (useful before importing into an OTW Archive).
- Track **OTW import** status (not imported / importing / imported / failed).

## Archive library

- A paginated list of collected works; search by title or source ID.
- **View** opens the offline reader: summary, creator, tags, series, chapter list, and the full chapter text — all served from your archive, no network needed.

## Source settings

- Create the AO3 source (it starts **paused** as a safety measure).
- **Browser identity** — User-Agent string and whether adult-content interstitials are accepted.
- **Request pacing and budgets** — minimum delay (ms), daily request cap, daily bandwidth cap, and maximum response size (0 = unlimited).
- **Failures and schedule** — request timeout (seconds), maximum failure attempts, and an optional operating window (UTC hours).

## System settings

- **Backup retention (days)** — how many days of backups to keep when running `npm run backup`; empty keeps everything.
- **Default job batch size** — prefilled in the new-job form.
- **Timezone** — used for server-side timestamps and backup stamps.
- **Installation (read-only)** — app version, whether authentication is on, and the data/export directories.

## Debug log

Two tabs:

- **API requests** — recent browser → API calls (method, path, status, duration, request ID). Tokens and request bodies are never recorded. Download or clear the log.
- **AO3 fetches** — raw fetches the collector made to the source, from stored fetch snapshots: work ID, HTTP status, response bytes, parser version, URL, and timestamp. 404s appear here as not-found outcomes, which is how you can confirm a work was checked and is gone.
