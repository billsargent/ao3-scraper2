#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/docker.sh"
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE" >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
DATA_DIR="${DATA_DIR:-$ROOT/data}"; [[ "$DATA_DIR" = /* ]] || DATA_DIR="$ROOT/$DATA_DIR"
BACKUP_ROOT="${BACKUP_DIR:-$ROOT/backups}"; [[ "$BACKUP_ROOT" = /* ]] || BACKUP_ROOT="$ROOT/$BACKUP_ROOT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PARTIAL="$BACKUP_ROOT/.${STAMP}.partial"; FINAL="$BACKUP_ROOT/$STAMP"
COMPOSE=("${DOCKER[@]}" compose --env-file "$ENV_FILE" -f "$ROOT/compose.production.yml")
mkdir -p "$PARTIAL" "$DATA_DIR"

resume() { "${COMPOSE[@]}" start api collector-worker planner-worker export-worker web >/dev/null 2>&1 || true; }
trap resume EXIT
printf 'Stopping application writers for a consistent backup...\n'
"${COMPOSE[@]}" stop web api collector-worker planner-worker export-worker >/dev/null

printf 'Dumping MariaDB...\n'
"${COMPOSE[@]}" exec -T collector-db mariadb-dump \
  -u"${COLLECTOR_DATABASE_USER:-collector}" -p"${COLLECTOR_DATABASE_PASSWORD}" \
  --single-transaction --routines --triggers --events "${COLLECTOR_DATABASE_NAME:-ao3_collector}" \
  | gzip -9 > "$PARTIAL/collector.sql.gz"

printf 'Archiving raw blobs and export packages...\n'
tar -C "$DATA_DIR" -czf "$PARTIAL/data.tar.gz" .
cat > "$PARTIAL/metadata.txt" <<META
created_at=$STAMP
app_version=${APP_VERSION:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)}
database=${COLLECTOR_DATABASE_NAME:-ao3_collector}
META
(cd "$PARTIAL" && sha256sum collector.sql.gz data.tar.gz metadata.txt > checksums.sha256)
mv "$PARTIAL" "$FINAL"
trap - EXIT
resume

if [ -n "${BACKUP_RETENTION_DAYS:-}" ]; then
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+${BACKUP_RETENTION_DAYS}" -exec rm -rf {} +
fi
printf 'Backup completed: %s\n' "$FINAL"
