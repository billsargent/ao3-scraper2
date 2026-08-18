#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.otw-private}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE" >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
OTW_DIR="$(cd "${OTW_DIR:-$ROOT/../otwarchive}" && pwd)"
BACKUP_ROOT="${OTW_BACKUP_DIR:-$ROOT/backups/otw}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; PARTIAL="$BACKUP_ROOT/.${STAMP}.partial"; FINAL="$BACKUP_ROOT/$STAMP"
COMPOSE=(sudo docker compose --env-file "$ENV_FILE" -f "$OTW_DIR/docker-compose.yml" -f "$OTW_DIR/docker-compose.private.yml" --profile dev)
mkdir -p "$PARTIAL"
restart() { "${COMPOSE[@]}" start web >/dev/null 2>&1 || true; [ "${OTW_ENABLE_RESQUE:-false}" = true ] && "${COMPOSE[@]}" start resque >/dev/null 2>&1 || true; }
trap restart EXIT
"${COMPOSE[@]}" stop web resque >/dev/null 2>&1 || true
"${COMPOSE[@]}" exec -T db mariadb-dump -uroot -pchange_me --single-transaction --routines --triggers otwarchive_development | gzip -9 > "$PARTIAL/otw.sql.gz"
FILE_PATHS=(config/local.yml)
[ -d "$OTW_DIR/storage" ] && FILE_PATHS+=(storage)
[ -d "$OTW_DIR/public/system" ] && FILE_PATHS+=(public/system)
tar -C "$OTW_DIR" -czf "$PARTIAL/files.tar.gz" "${FILE_PATHS[@]}"
printf 'created_at=%s\napp=private-otw\n' "$STAMP" > "$PARTIAL/metadata.txt"
(cd "$PARTIAL" && sha256sum otw.sql.gz files.tar.gz metadata.txt > checksums.sha256)
mv "$PARTIAL" "$FINAL"; trap - EXIT; restart
echo "Private OTW backup completed: $FINAL"
