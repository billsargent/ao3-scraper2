#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OTW_DIR="${OTW_DIR:-$ROOT/../otwarchive}"
COLLECTOR_DATABASE_URL="${COLLECTOR_DATABASE_URL:-mysql://collector:collector_local_only@localhost:3307/ao3_collector}"
COMPOSE=(sudo docker compose)
OTW_COMPOSE=(sudo docker compose -f docker-compose.yml -f docker-compose.preservation-test.yml)

log() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null || fail "Docker is not installed"
[ -d "$OTW_DIR" ] || fail "OTW checkout not found at $OTW_DIR"

cd "$ROOT"
log "Installing Node workspace dependencies"
npm install

log "Starting collector MariaDB and applying migrations"
"${COMPOSE[@]}" up -d --wait collector-db
COLLECTOR_DATABASE_URL="$COLLECTOR_DATABASE_URL" npm run db:migrate

if [ "${SKIP_FAST_CHECKS:-false}" != "true" ]; then
  log "Running TypeScript and browser-independent tests"
  npm run check
fi

log "Building a transfer package through collector persistence and export code"
rm -rf "$ROOT/tmp/full-pipeline"
mkdir -p "$ROOT/tmp/full-pipeline"
COLLECTOR_DATABASE_URL="$COLLECTOR_DATABASE_URL" npx tsx scripts/build-e2e-package.ts "$ROOT/tmp/full-pipeline/exports" > "$ROOT/tmp/full-pipeline/result.json"
PACKAGE_DIR="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).packageDirectory)' "$ROOT/tmp/full-pipeline/result.json")"
npm run package:verify -- "$PACKAGE_DIR"

log "Installing importer overlay and generated package into disposable OTW checkout"
bash ./scripts/install-into-otw.sh "$OTW_DIR"
rm -rf "$OTW_DIR/spec/fixtures/preservation/e2e-package"
cp -R "$PACKAGE_DIR" "$OTW_DIR/spec/fixtures/preservation/e2e-package"
chmod +x "$OTW_DIR"/bin/* "$OTW_DIR"/script/reset_database.sh 2>/dev/null || true
cp "$OTW_DIR/config/docker/database.yml" "$OTW_DIR/config/database.yml"
cp "$OTW_DIR/config/docker/redis.yml" "$OTW_DIR/config/redis.yml"
cp "$OTW_DIR/config/docker/local.yml" "$OTW_DIR/config/local.yml"

cd "$OTW_DIR"
cleanup() {
  if [ "${KEEP_OTW_CONTAINERS:-false}" != "true" ]; then
    "${OTW_COMPOSE[@]}" down >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log "Starting low-memory OTW dependencies"
"${OTW_COMPOSE[@]}" up -d db redis mc es
for _ in $(seq 1 120); do
  if curl -fsS http://localhost:9200 >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS http://localhost:9200 >/dev/null || fail "Elasticsearch did not become ready"

log "Preparing disposable OTW test database"
"${OTW_COMPOSE[@]}" run --rm --no-deps -e RAILS_ENV=test test \
  bundle exec rake db:otwseed

log "Running collector-to-OTW integration specs"
"${OTW_COMPOSE[@]}" run --rm --no-deps \
  -e RAILS_ENV=test \
  -e PRESERVATION_E2E_PACKAGE=/otwa/spec/fixtures/preservation/e2e-package \
  -e PRESERVATION_FIXTURE_PACKAGE=/otwa/spec/fixtures/preservation/package-v1 \
  -e PRESERVATION_UPDATE_FIXTURE_PACKAGE=/otwa/spec/fixtures/preservation/package-v1-update \
  test bundle exec rspec \
  spec/services/preservation_import/package_reader_spec.rb \
  spec/services/preservation_import/collector_notifier_spec.rb \
  spec/services/preservation_import/runner_spec.rb \
  spec/services/preservation_import/e2e_package_spec.rb

log "FULL PIPELINE PASSED: fixture -> MariaDB -> verified package -> native OTW records"
