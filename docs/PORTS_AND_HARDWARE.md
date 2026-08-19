# Ports, URLs, and hardware sizing

> **Working directory:** Unless a section explicitly says otherwise, run commands from the `ao3-offsite-pipeline` repository root.
>
> ```bash
> cd /path/to/ao3-offsite-pipeline
> ```

## Which URL should I open?

Use only the UI that matches the mode you started:

| Mode | Open in browser | Purpose |
|---|---:|---|
| Collector development | `http://localhost:5173` | Vite operator interface |
| Collector production | `http://localhost:8080` | Nginx-served operator interface |
| Private OTW Archive | `http://localhost:3000` | Native OTW work/archive pages |

`5173` and `8080` are alternatives for the same Archive Relay collector UI. Do not expect both unless you deliberately start both development and production stacks.

`OTW_WEB_PORT` can change the private OTW port. The Arena sandbox has sometimes used `3002` to avoid a port conflict; normal installations default to `3000`.

---

## Collector development ports

Started with development commands from `START_HERE.md`:

| Port | Service | Should you open it? |
|---:|---|---|
| `5173` | Vite Archive Relay UI | Yes |
| `3001` | Fastify collector API | Usually no; the UI calls it |
| `3307` | Collector MariaDB host mapping | No |

Planner, export, and source workers do not listen on network ports.

Health checks:

```bash
curl http://localhost:3001/api/health/live
curl http://localhost:3001/api/health/ready
```

When `API_TOKEN` is configured, readiness requires:

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  http://localhost:3001/api/health/ready
```

---

## Collector production ports

Started with:

```bash
npm run production:up
```

| Port | Exposure | Service |
|---:|---|---|
| `8080` | Host | Nginx UI and `/api` reverse proxy |
| `3001` | Compose network only | Fastify API |
| `3306` | Compose network only | Collector MariaDB |

Only `8080` is published by `compose.production.yml`. Put it behind HTTPS/VPN before remote access.

Production health:

```bash
curl http://localhost:8080/healthz
curl -H "Authorization: Bearer $API_TOKEN" \
  http://localhost:8080/api/health/ready
```

---

## Private OTW Archive ports

Started with:

```bash
npm run otw:up
```

| Port | Service | Purpose |
|---:|---|---|
| `3000` | OTW Rails web | Open this in the browser |
| `3306` | OTW MariaDB | Internal dependency |
| `6379` | Redis | Jobs/queues |
| `9200` | Elasticsearch HTTP | Search/indexing |
| `9300` | Elasticsearch transport | Elasticsearch internal |
| `9400` | Elasticsearch alternate/dev endpoint | OTW development configuration |
| `11211` | Memcached | OTW cache |

The OTW reference Compose file publishes several dependency ports. Keep the host firewalled/private. Only the Rails web port should be remotely reachable.

Change the web port in `.env.otw-private`:

```dotenv
OTW_WEB_PORT=3002
```

Then rerun:

```bash
npm run otw:up
```

Private OTW checks:

```bash
curl -I http://localhost:3000/
```

Expected header:

```text
X-Robots-Tag: noindex, nofollow, noarchive, nosnippet
```

---

## Testing-only ports

OTW's full Selenium test profile can additionally use:

| Port | Service |
|---:|---|
| `4444` | Selenium/Chromium |
| `5100` | Capybara test server |

These are not required for normal operation.

---

# Raspberry Pi guidance

## Collector only

Archive Relay's collector stack is reasonable on modern Raspberry Pi hardware because collection is deliberately low concurrency.

Recommended minimum:

- Raspberry Pi 4 with 4 GB RAM for small collections
- Raspberry Pi 4/5 with 8 GB preferred
- 64-bit Raspberry Pi OS or another ARM64 Linux
- USB 3 SSD/NVMe; do not use an SD card for MariaDB and continuous writes
- Wired Ethernet
- Cooling for sustained work
- Regular off-device backups

Expected collector memory range for a modest workload:

| Component | Approximate memory |
|---|---:|
| MariaDB | 250–700 MB |
| API + three Node workers | 250–600 MB total |
| Nginx | under 50 MB |
| OS/filesystem cache | 500 MB+ |

A 4 GB Pi can run the collector, but 8 GB gives safer database/cache headroom.

## Private OTW only

OTW is significantly heavier:

- Rails web process
- MariaDB
- Redis
- Memcached
- Elasticsearch
- Optional Resque worker

Recommendations:

- Pi 5 with 8 GB is the practical minimum for the low-memory profile
- Pi 5 with 16 GB is strongly preferred
- Fast SSD/NVMe is required
- Active cooling is required
- Keep `OTW_ENABLE_RESQUE=false` on constrained systems unless search/background processing is necessary
- Use the 128 MB Elasticsearch heap from the private profile, understanding that large indexes will outgrow it

A Pi 4 with 4 GB is not recommended for OTW plus Elasticsearch.

## Collector and OTW on one Pi

For both stacks together:

- Pi 5 16 GB recommended
- Pi 5 8 GB may work for the current 18-work dataset in low-memory mode, but leaves little growth margin
- Do not build all Docker images on the Pi if avoidable; use signed ARM64 images from CI
- Place collector and OTW databases on SSD/NVMe
- Configure swap or zram for emergency headroom, but do not rely on swap for normal Elasticsearch operation

For a growing archive, two machines are safer:

1. Pi/host A — collector, raw blobs, packages
2. Host B — private OTW Archive

## Scale warning

The current 18-work validation set is tiny. Hardware needs depend more on stored content than request speed. Millions of works, comments, or embedded assets will require substantial SSD capacity and more database/search memory. A Raspberry Pi is suitable for controlled personal collections, testing, and modest backups—not a full-scale replacement for AO3 infrastructure.

## Storage recommendations

- Keep MariaDB and raw blobs on SSD/NVMe
- Monitor free space and inode usage
- Reserve at least twice current live-data size for backups and temporary exports
- Keep one backup off the Pi
- Test restores on another device
