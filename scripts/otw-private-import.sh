#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.otw-private}"
PACKAGE="${1:-}"
[ -d "$PACKAGE" ] || { echo "Usage: $0 /path/to/package-directory" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE" >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
OTW_DIR="$(cd "${OTW_DIR:-$ROOT/../otwarchive}" && pwd)"
PACKAGE="$(cd "$PACKAGE" && pwd)"
PACKAGE_ID="$(node -e 'console.log(require(process.argv[1]).packageId)' "$PACKAGE/manifest.json")"
DEST="$OTW_DIR/tmp/private-import/$PACKAGE_ID"
sudo rm -rf "$DEST"
sudo mkdir -p "$(dirname "$DEST")"
sudo cp -R "$PACKAGE" "$DEST"
sudo chmod -R a+rX "$DEST"
COMPOSE=(sudo docker compose --env-file "$ENV_FILE" -f "$OTW_DIR/docker-compose.yml" -f "$OTW_DIR/docker-compose.private.yml" --profile dev)
"${COMPOSE[@]}" exec -T \
  -e PACKAGE="/otwa/tmp/private-import/$PACKAGE_ID" \
  -e ARCHIVIST="$OTW_ARCHIVIST_LOGIN" \
  web bundle exec rake preservation:import
"${COMPOSE[@]}" exec -T web bundle exec rails runner \
  "puts({works: PreservationWorkLink.count, chapters: PreservationChapterLink.count, series: PreservationSeriesLink.count}.to_json)"
echo "Imported package $PACKAGE_ID into private OTW Archive"
