#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/docker.sh"
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE; copy env.production.example and edit it." >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
DATA_DIR="${DATA_DIR:-$ROOT/data}"; [[ "$DATA_DIR" = /* ]] || DATA_DIR="$ROOT/$DATA_DIR"
mkdir -p "$DATA_DIR/blobs" "$DATA_DIR/exports"
cd "$ROOT"
UP_ARGS=(up -d --wait)
[ "${SKIP_BUILD:-false}" = true ] || UP_ARGS+=(--build)
"${DOCKER[@]}" compose --env-file "$ENV_FILE" -f compose.production.yml "${UP_ARGS[@]}"
printf '\nArchive Relay is ready at http://localhost:%s\n' "$(grep '^WEB_PORT=' "$ENV_FILE" | cut -d= -f2 || echo 8080)"
