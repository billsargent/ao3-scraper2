#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE; copy .env.production.example and edit it." >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
DATA_DIR="${DATA_DIR:-$ROOT/data}"; [[ "$DATA_DIR" = /* ]] || DATA_DIR="$ROOT/$DATA_DIR"
mkdir -p "$DATA_DIR/blobs" "$DATA_DIR/exports"
cd "$ROOT"
docker compose --env-file "$ENV_FILE" -f compose.production.yml up -d --build --wait
printf '\nArchive Relay is ready at http://localhost:%s\n' "$(grep '^WEB_PORT=' "$ENV_FILE" | cut -d= -f2 || echo 8080)"
