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
"${COMPOSE[@]}" up -d db redis mc es
for _ in $(seq 1 120); do curl -fsS http://localhost:9200 >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://localhost:9200 >/dev/null || { echo "Elasticsearch failed to start" >&2; exit 1; }

if ! "${COMPOSE[@]}" exec -T db mariadb -uroot -pchange_me -N -e "SHOW DATABASES LIKE 'otwarchive_development'" | grep -q otwarchive_development; then
  timeout 900 "${COMPOSE[@]}" run --rm -T --no-deps web bundle exec rake db:otwseed
else
  timeout 900 "${COMPOSE[@]}" run --rm -T --no-deps web bundle exec rake db:migrate
fi

timeout 300 "${COMPOSE[@]}" run --rm -T --no-deps \
  -e OTW_ARCHIVIST_LOGIN="$OTW_ARCHIVIST_LOGIN" \
  -e OTW_ARCHIVIST_EMAIL="$OTW_ARCHIVIST_EMAIL" \
  -e OTW_ARCHIVIST_PASSWORD="$OTW_ARCHIVIST_PASSWORD" \
  web bundle exec rails runner script/create_offline_archivist.rb
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
