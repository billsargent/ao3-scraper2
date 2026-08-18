#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.otw-private}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE" >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
OTW_DIR="$(cd "${OTW_DIR:-$ROOT/../otwarchive}" && pwd)"
sudo docker compose --env-file "$ENV_FILE" -f "$OTW_DIR/docker-compose.yml" -f "$OTW_DIR/docker-compose.private.yml" --profile dev down
