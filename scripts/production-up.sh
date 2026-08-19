#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/docker.sh"
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE; copy env.production.example and edit it." >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
if [ "${SKIP_BUILD:-false}" != true ]; then
  APP_VERSION="${APP_VERSION_OVERRIDE:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "${APP_VERSION:-development}")}"
  export APP_VERSION
  if grep -q '^APP_VERSION=' "$ENV_FILE"; then
    sed -i "s/^APP_VERSION=.*/APP_VERSION=$APP_VERSION/" "$ENV_FILE"
  fi
fi
DATA_DIR="${DATA_DIR:-$ROOT/data}"; [[ "$DATA_DIR" = /* ]] || DATA_DIR="$ROOT/$DATA_DIR"
mkdir -p "$DATA_DIR/blobs" "$DATA_DIR/exports"
cd "$ROOT"
UP_ARGS=(up -d --wait)
[ "${SKIP_BUILD:-false}" = true ] || UP_ARGS+=(--build)
"${DOCKER[@]}" compose --env-file "$ENV_FILE" -f compose.production.yml "${UP_ARGS[@]}"
printf '\nArchive Relay is ready at http://localhost:%s\n' "$(grep '^WEB_PORT=' "$ENV_FILE" | cut -d= -f2 || echo 8080)"
