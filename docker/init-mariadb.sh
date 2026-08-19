#!/usr/bin/env bash
set -euo pipefail

# One-shot initializer run by supervisord after mariadbd is up. On the very
# first boot it gives root a password (used by the backup/restore scripts) via
# the unix-socket login; on later boots it uses password auth and simply
# re-ensures the collector database and application user exist.

SOCKET="/run/mysqld/mysqld.sock"
ROOT_PASSWORD="${MARIADB_ROOT_PASSWORD:?MARIADB_ROOT_PASSWORD is required}"
DB_NAME="${COLLECTOR_DATABASE_NAME:-ao3_collector}"
DB_USER="${COLLECTOR_DATABASE_USER:-collector}"
DB_PASSWORD="${COLLECTOR_DATABASE_PASSWORD:?COLLECTOR_DATABASE_PASSWORD is required}"

for _ in $(seq 1 60); do
  if mariadb-admin ping --socket="$SOCKET" --silent >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! mariadb-admin ping --socket="$SOCKET" --silent >/dev/null 2>&1; then
  echo "init-mariadb: MariaDB did not become ready" >&2
  exit 1
fi

# Prefer password auth (already configured on a previous boot); fall back to the
# unix-socket root login for the very first boot. --socket needs the = form so
# the next token is not mistaken for the socket path.
ROOT_ARGS=(--socket="$SOCKET" -uroot)
if mariadb --socket="$SOCKET" -uroot -p"$ROOT_PASSWORD" -e "SELECT 1" >/dev/null 2>&1; then
  ROOT_ARGS=(--socket="$SOCKET" -uroot -p"$ROOT_PASSWORD")
fi

mariadb "${ROOT_ARGS[@]}" <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED BY '${ROOT_PASSWORD}';
CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '${ROOT_PASSWORD}';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASSWORD}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'127.0.0.1';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "init-mariadb: database '${DB_NAME}' and user '${DB_USER}' ready"
