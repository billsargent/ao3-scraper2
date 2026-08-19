#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/docker.sh"
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE; copy env.production.example and edit it." >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
if [ "${SKIP_BUILD:-false}" != true ]; then
  if [ -n "${APP_VERSION_OVERRIDE:-}" ]; then
    APP_VERSION="$APP_VERSION_OVERRIDE"
  elif APP_VERSION="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)"; then
    :
  elif command -v sha256sum >/dev/null 2>&1; then
    # Downloaded ZIPs do not contain .git. Give those builds a stable source-content ID
    # instead of silently reusing the APP_VERSION from the previous installation.
    APP_VERSION="zip-$(
      cd "$ROOT"
      find apps packages docker scripts compose.production.yml package.json package-lock.json \
        -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12
    )"
  else
    APP_VERSION="${APP_VERSION:-development}"
  fi
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
