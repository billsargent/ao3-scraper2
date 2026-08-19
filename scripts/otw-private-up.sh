#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/docker.sh"
ENV_FILE="${ENV_FILE:-$ROOT/.env.otw-private}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE; copy env.otw-private.example and edit it." >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
OTW_DIR="$(cd "${OTW_DIR:-$ROOT/../otwarchive}" && pwd)"
[ "$OTW_ARCHIVIST_PASSWORD" != "change-me-to-a-strong-password" ] || { echo "Change OTW_ARCHIVIST_PASSWORD" >&2; exit 1; }

bash "$ROOT/scripts/install-into-otw.sh" "$OTW_DIR"
cat > "$OTW_DIR/config/local.yml" <<YAML
ES_URL: es:9200
MEMCACHED_SERVERS: mc:11211
APP_URL: '${OTW_APP_URL:-http://localhost:3000}'
APP_HOST: '${OTW_APP_HOST:-localhost}'
APP_NAME: '${OTW_APP_NAME:-Private Offline Archive}'
APP_SHORT_NAME: '${OTW_APP_SHORT_NAME:-Offline AO3}'
PERFORM_DELIVERIES: false
YAML
cp "$OTW_DIR/config/docker/database.yml" "$OTW_DIR/config/database.yml"
cp "$OTW_DIR/config/docker/redis.yml" "$OTW_DIR/config/redis.yml"
chmod +x "$OTW_DIR"/bin/* "$OTW_DIR"/script/reset_database.sh 2>/dev/null || true

COMPOSE=("${DOCKER[@]}" compose --env-file "$ENV_FILE" -f "$OTW_DIR/docker-compose.yml" -f "$OTW_DIR/docker-compose.private.yml" --profile dev)
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$OTW_DIR")}"
cleanup_oneoffs() {
  local ids=()
  mapfile -t ids < <("${DOCKER[@]}" ps -aq \
    --filter "label=com.docker.compose.project=$PROJECT_NAME" \
    --filter "label=com.docker.compose.oneoff=True")
  if ((${#ids[@]})); then "${DOCKER[@]}" rm -f "${ids[@]}" >/dev/null 2>&1 || true; fi
}
interrupt_setup() {
  echo >&2
  echo "Stopping OTW setup container..." >&2
  cleanup_oneoffs
  exit 130
}
trap interrupt_setup INT TERM

"${COMPOSE[@]}" up -d db redis mc es
for _ in $(seq 1 120); do curl -fsS http://localhost:9200 >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://localhost:9200 >/dev/null || { echo "Elasticsearch failed to start" >&2; exit 1; }

# db:otwseed finishes by rebuilding derived filters and queues. Those operations can
# appear hung for a long time on a Pi and are unnecessary for an empty private
# preservation archive. Load the required schema and fixtures, but skip that work.
DATABASE_READY="$("${COMPOSE[@]}" exec -T db mariadb -uroot -pchange_me -N -e \
  "SELECT COUNT(*) FROM otwarchive_development.languages" 2>/dev/null || true)"
if [[ ! "$DATABASE_READY" =~ ^[1-9][0-9]*$ ]]; then
  timeout --foreground --kill-after=20s 900 "${COMPOSE[@]}" run --rm -T --no-deps web \
    bundle exec rake db:reset_and_migrate db:seed fixtures:load
else
  timeout --foreground --kill-after=20s 900 "${COMPOSE[@]}" run --rm -T --no-deps web bundle exec rake db:migrate
fi

timeout --foreground --kill-after=20s 300 "${COMPOSE[@]}" run --rm -T --no-deps \
  -e OTW_ARCHIVIST_LOGIN="$OTW_ARCHIVIST_LOGIN" \
  -e OTW_ARCHIVIST_EMAIL="$OTW_ARCHIVIST_EMAIL" \
  -e OTW_ARCHIVIST_PASSWORD="$OTW_ARCHIVIST_PASSWORD" \
  web bundle exec rails runner script/create_offline_archivist.rb
trap - INT TERM
"${COMPOSE[@]}" up -d --no-deps --force-recreate web
if [ "${OTW_ENABLE_RESQUE:-false}" = "true" ]; then
  "${COMPOSE[@]}" up -d resque
else
  "${COMPOSE[@]}" stop resque >/dev/null 2>&1 || true
  echo "Resque is disabled for the low-memory profile. Set OTW_ENABLE_RESQUE=true on a host with more memory."
fi

for _ in $(seq 1 90); do curl -fsS "${OTW_APP_URL:-http://localhost:3000}" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "${OTW_APP_URL:-http://localhost:3000}" >/dev/null || { echo "OTW web did not become ready" >&2; exit 1; }
echo "Private OTW Archive is ready at ${OTW_APP_URL:-http://localhost:3000}"
echo "Archivist login: $OTW_ARCHIVIST_LOGIN"
