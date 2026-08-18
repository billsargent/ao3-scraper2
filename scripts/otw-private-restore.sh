#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.otw-private}"; BACKUP="${1:-}"
[ -d "$BACKUP" ] || { echo "Usage: CONFIRM_RESTORE=yes $0 /path/to/otw-backup" >&2; exit 1; }
[ "${CONFIRM_RESTORE:-no}" = yes ] || { echo "Refusing restore without CONFIRM_RESTORE=yes" >&2; exit 1; }
(cd "$BACKUP" && sha256sum -c checksums.sha256)
set -a; source "$ENV_FILE"; set +a
OTW_DIR="$(cd "${OTW_DIR:-$ROOT/../otwarchive}" && pwd)"
COMPOSE=(sudo docker compose --env-file "$ENV_FILE" -f "$OTW_DIR/docker-compose.yml" -f "$OTW_DIR/docker-compose.private.yml" --profile dev)
"${COMPOSE[@]}" stop web resque >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d db redis mc es
"${COMPOSE[@]}" exec -T db mariadb -uroot -pchange_me <<SQL
DROP DATABASE IF EXISTS otwarchive_development;
CREATE DATABASE otwarchive_development CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
SQL
gunzip -c "$BACKUP/otw.sql.gz" | "${COMPOSE[@]}" exec -T db mariadb -uroot -pchange_me otwarchive_development
tar -C "$OTW_DIR" -xzf "$BACKUP/files.tar.gz"
"${COMPOSE[@]}" run --rm --no-deps web bundle exec rake db:migrate
"${COMPOSE[@]}" up -d --no-deps web
[ "${OTW_ENABLE_RESQUE:-false}" = true ] && "${COMPOSE[@]}" up -d resque || true
echo "Private OTW restore completed from $BACKUP"
