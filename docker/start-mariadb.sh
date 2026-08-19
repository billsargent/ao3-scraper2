#!/usr/bin/env bash
set -euo pipefail

# Initializes an empty MariaDB datadir (defensive: the base image usually ships
# a pre-initialized datadir) and then execs mariadbd in the foreground so
# supervisord can supervise it directly.

DATADIR="${MARIADB_DATA_DIR:-/var/lib/mysql}"
SOCKET="/run/mysqld/mysqld.sock"

if [ ! -d "$DATADIR/mysql" ]; then
  echo "start-mariadb: initializing empty datadir at $DATADIR"
  mariadb-install-db --user=mysql --datadir="$DATADIR" >/dev/null
fi

exec mariadbd --user=mysql --bind-address=127.0.0.1 --socket="$SOCKET"
