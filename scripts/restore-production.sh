#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/docker.sh"
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
BACKUP="${1:-}"
[ -d "$BACKUP" ] || { echo "Usage: CONFIRM_RESTORE=yes $0 /path/to/backup" >&2; exit 1; }
[ "${CONFIRM_RESTORE:-no}" = "yes" ] || { echo "Refusing destructive restore without CONFIRM_RESTORE=yes" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE" >&2; exit 1; }
(cd "$BACKUP" && sha256sum -c checksums.sha256)
set -a; source "$ENV_FILE"; set +a
DATA_DIR="${DATA_DIR:-$ROOT/data}"; [[ "$DATA_DIR" = /* ]] || DATA_DIR="$ROOT/$DATA_DIR"
COMPOSE=("${DOCKER[@]}" compose --env-file "$ENV_FILE" -f "$ROOT/compose.production.yml")

printf 'Ensuring the collector container is running...\n'
"${COMPOSE[@]}" up -d --wait collector

printf 'Replacing MariaDB database...\n'
"${COMPOSE[@]}" exec -T collector mariadb -uroot -p"${MARIADB_ROOT_PASSWORD}" <<SQL
DROP DATABASE IF EXISTS \`${COLLECTOR_DATABASE_NAME:-ao3_collector}\`;
CREATE DATABASE \`${COLLECTOR_DATABASE_NAME:-ao3_collector}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON \`${COLLECTOR_DATABASE_NAME:-ao3_collector}\`.* TO '${COLLECTOR_DATABASE_USER:-collector}'@'127.0.0.1';
GRANT ALL PRIVILEGES ON \`${COLLECTOR_DATABASE_NAME:-ao3_collector}\`.* TO '${COLLECTOR_DATABASE_USER:-collector}'@'localhost';
FLUSH PRIVILEGES;
SQL
gunzip -c "$BACKUP/collector.sql.gz" | "${COMPOSE[@]}" exec -T collector \
  mariadb -u"${COLLECTOR_DATABASE_USER:-collector}" -p"${COLLECTOR_DATABASE_PASSWORD}" "${COLLECTOR_DATABASE_NAME:-ao3_collector}"

printf 'Replacing blob/export data...\n'
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"
tar -C "$DATA_DIR" -xzf "$BACKUP/data.tar.gz"

printf 'Restarting collector so the API re-runs migrations and workers reconnect...\n'
"${COMPOSE[@]}" restart collector
printf 'Restore completed from %s\n' "$BACKUP"
