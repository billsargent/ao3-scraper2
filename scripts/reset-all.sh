#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/docker.sh"
[ "${CONFIRM_RESET:-}" = "ERASE_ALL" ] || {
  echo "This deletes Archive Relay and OTW containers, database volumes, blobs, packages, and OTW local storage." >&2
  echo "Run: CONFIRM_RESET=ERASE_ALL npm run services:reset" >&2
  exit 1
}

remove_path() {
  rm -rf "$@" 2>/dev/null || {
    command -v sudo >/dev/null || return 1
    sudo rm -rf "$@"
  }
}

cd "$ROOT"
PROD_ENV="$ROOT/.env.production"; [ -f "$PROD_ENV" ] || PROD_ENV="$ROOT/env.production.example"
"${DOCKER[@]}" compose --env-file "$PROD_ENV" -f compose.production.yml down -v --remove-orphans || true
"${DOCKER[@]}" compose -f docker-compose.yml down -v --remove-orphans || true

OTW_ENV="$ROOT/.env.otw-private"; [ -f "$OTW_ENV" ] || OTW_ENV="$ROOT/env.otw-private.example"
set -a; source "$OTW_ENV"; set +a
if OTW_DIR_VALUE="$(cd "${OTW_DIR:-$ROOT/../otwarchive}" 2>/dev/null && pwd)" && [ -f "$OTW_DIR_VALUE/docker-compose.yml" ]; then
  if [ -f "$OTW_DIR_VALUE/docker-compose.private.yml" ]; then
    "${DOCKER[@]}" compose --env-file "$OTW_ENV" -f "$OTW_DIR_VALUE/docker-compose.yml" -f "$OTW_DIR_VALUE/docker-compose.private.yml" --profile dev down -v --remove-orphans || true
  else
    "${DOCKER[@]}" compose -f "$OTW_DIR_VALUE/docker-compose.yml" --profile dev down -v --remove-orphans || true
  fi
  remove_path "$OTW_DIR_VALUE/storage" "$OTW_DIR_VALUE/public/system" "$OTW_DIR_VALUE/tmp/private-import"
fi

remove_path "$ROOT/data" "$ROOT/tmp/full-pipeline"
if [ "${ERASE_BACKUPS:-no}" = yes ]; then remove_path "$ROOT/backups"; fi
if [ "${ERASE_CONFIG:-no}" = yes ]; then rm -f "$ROOT/.env" "$ROOT/.env.production" "$ROOT/.env.otw-private"; fi

echo "Reset complete. Docker images and source code were preserved."
echo "Rebuild/start with: npm run setup:all -- --start"
