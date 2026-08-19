#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START=false; RUN_TESTS=true; BUILD_OTW=true
for arg in "$@"; do
  case "$arg" in
    --start) START=true ;;
    --skip-tests) RUN_TESTS=false ;;
    --skip-otw-build) BUILD_OTW=false ;;
    -h|--help)
      echo "Usage: scripts/setup-all.sh [--start] [--skip-tests] [--skip-otw-build]"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "Node.js is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required to generate secrets" >&2; exit 1; }
source "$ROOT/scripts/lib/docker.sh"

cd "$ROOT"
# Keep conventional hidden examples synchronized, while visible examples survive sandbox ZIP downloads.
cp env.example .env.example
cp env.production.example .env.production.example
cp env.otw-private.example .env.otw-private.example

if [ ! -f .env.production ]; then
  DB_ROOT="$(openssl rand -hex 24)"; DB_PASS="$(openssl rand -hex 24)"; API_TOKEN_VALUE="$(openssl rand -hex 32)"
  APP_COMMIT_VALUE="$(git rev-parse --short HEAD 2>/dev/null || echo development)"
  sed \
    -e "s/change-me-root-password/$DB_ROOT/g" \
    -e "s/change-me-url-safe-password/$DB_PASS/g" \
    -e "s/change-me-to-at-least-32-random-characters/$API_TOKEN_VALUE/g" \
    -e "s/^APP_VERSION=.*/APP_VERSION=$APP_COMMIT_VALUE/" \
    -e "s/^APP_UID=.*/APP_UID=$(id -u)/" \
    -e "s/^APP_GID=.*/APP_GID=$(id -g)/" \
    env.production.example > .env.production
  echo "Created .env.production with generated secrets."
else
  API_TOKEN_VALUE="$(grep '^API_TOKEN=' .env.production | cut -d= -f2-)"
fi

if [ ! -f .env.otw-private ]; then
  OTW_PASSWORD="$(openssl rand -hex 16)"
  sed \
    -e "s/change-me-to-a-strong-password/$OTW_PASSWORD/g" \
    -e "s|^COLLECTOR_API_TOKEN=.*|COLLECTOR_API_TOKEN=$API_TOKEN_VALUE|" \
    env.otw-private.example > .env.otw-private
  echo "Created .env.otw-private. Archivist credentials are stored there."
elif grep -q '^COLLECTOR_API_TOKEN=$' .env.otw-private; then
  sed -i "s|^COLLECTOR_API_TOKEN=$|COLLECTOR_API_TOKEN=$API_TOKEN_VALUE|" .env.otw-private
fi

OTW_DIR_VALUE="$(set -a; source .env.otw-private; set +a; cd "${OTW_DIR:-$ROOT/../otwarchive}" && pwd)"
[ -d "$OTW_DIR_VALUE" ] || { echo "OTW checkout not found: $OTW_DIR_VALUE" >&2; exit 1; }

npm ci
npm run build
npm run web:build
if $RUN_TESTS; then
  npm run check
fi

"${DOCKER[@]}" compose --env-file .env.production -f compose.production.yml build
bash scripts/install-into-otw.sh "$OTW_DIR_VALUE"
if $BUILD_OTW; then
  "${DOCKER[@]}" compose --env-file .env.otw-private \
    -f "$OTW_DIR_VALUE/docker-compose.yml" -f "$OTW_DIR_VALUE/docker-compose.private.yml" \
    --profile dev build web resque
fi

if $START; then
  bash scripts/all-services.sh start all
else
  echo
  echo "Setup and builds completed. Start everything with:"
  echo "  bash scripts/all-services.sh start all"
fi
