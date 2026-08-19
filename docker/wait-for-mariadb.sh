#!/usr/bin/env bash
set -euo pipefail

# Waits until the collector database accepts the application user's connection.
# Used by the API and worker startup commands so they never race the one-shot
# db-init program or a cold MariaDB start.

DB_NAME="${COLLECTOR_DATABASE_NAME:-ao3_collector}"
DB_USER="${COLLECTOR_DATABASE_USER:-collector}"
DB_PASSWORD="${COLLECTOR_DATABASE_PASSWORD:?COLLECTOR_DATABASE_PASSWORD is required}"

for _ in $(seq 1 120); do
  if mariadb -h 127.0.0.1 -u"$DB_USER" -p"$DB_PASSWORD" -e "SELECT 1" "$DB_NAME" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done
echo "wait-for-mariadb: timed out waiting for collector database" >&2
exit 1
