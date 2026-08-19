#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-status}"
SCOPE="${2:-all}"
PROD_ENV="${PROD_ENV_FILE:-$ROOT/.env.production}"
OTW_ENV="${OTW_ENV_FILE:-$ROOT/.env.otw-private}"

usage() {
  cat <<'TXT'
Usage: scripts/all-services.sh <start|stop|restart|status|logs|backup> [all|collector|otw]

Examples:
  scripts/all-services.sh start all
  scripts/all-services.sh stop all
  scripts/all-services.sh status
  scripts/all-services.sh logs collector
TXT
}

valid_scope() { [[ "$SCOPE" == all || "$SCOPE" == collector || "$SCOPE" == otw ]]; }
if [[ "$ACTION" == -h || "$ACTION" == --help || "$ACTION" == help ]]; then usage; exit 0; fi
valid_scope || { usage; exit 2; }
source "$ROOT/scripts/lib/docker.sh"

collector() {
  local command="$1"
  case "$command" in
    start) ENV_FILE="$PROD_ENV" SKIP_BUILD=true bash "$ROOT/scripts/production-up.sh" ;;
    stop) ENV_FILE="$PROD_ENV" bash "$ROOT/scripts/production-down.sh" ;;
    status) "${DOCKER[@]}" compose --env-file "$PROD_ENV" -f "$ROOT/compose.production.yml" ps ;;
    logs) "${DOCKER[@]}" compose --env-file "$PROD_ENV" -f "$ROOT/compose.production.yml" logs --tail=200 ;;
    backup) ENV_FILE="$PROD_ENV" bash "$ROOT/scripts/backup-production.sh" ;;
  esac
}

otw() {
  local command="$1"
  [ -f "$OTW_ENV" ] || { echo "Missing $OTW_ENV" >&2; return 1; }
  set -a; source "$OTW_ENV"; set +a
  local otw_dir
  otw_dir="$(cd "${OTW_DIR:-$ROOT/../otwarchive}" && pwd)"
  case "$command" in
    start) ENV_FILE="$OTW_ENV" bash "$ROOT/scripts/otw-private-up.sh" ;;
    stop) ENV_FILE="$OTW_ENV" bash "$ROOT/scripts/otw-private-down.sh" ;;
    status) "${DOCKER[@]}" compose --env-file "$OTW_ENV" -f "$otw_dir/docker-compose.yml" -f "$otw_dir/docker-compose.private.yml" --profile dev ps ;;
    logs) "${DOCKER[@]}" compose --env-file "$OTW_ENV" -f "$otw_dir/docker-compose.yml" -f "$otw_dir/docker-compose.private.yml" --profile dev logs --tail=200 ;;
    backup) ENV_FILE="$OTW_ENV" bash "$ROOT/scripts/otw-private-backup.sh" ;;
  esac
}

run_scope() {
  local command="$1"
  if [[ "$SCOPE" == all || "$SCOPE" == collector ]]; then collector "$command"; fi
  if [[ "$SCOPE" == all || "$SCOPE" == otw ]]; then otw "$command"; fi
}

case "$ACTION" in
  start)
    [ "$SCOPE" == otw ] || [ -f "$PROD_ENV" ] || { echo "Missing $PROD_ENV" >&2; exit 1; }
    run_scope start
    collector_port="$(set -a; source "$PROD_ENV" 2>/dev/null || true; echo "${WEB_PORT:-8080}")"
    otw_url="$(set -a; source "$OTW_ENV" 2>/dev/null || true; echo "${OTW_APP_URL:-http://localhost:3000}")"
    echo
    echo "Services started. Collector: http://localhost:${collector_port}  Private OTW: ${otw_url}"
    ;;
  stop) run_scope stop ;;
  restart) run_scope stop; run_scope start ;;
  status) run_scope status ;;
  logs) run_scope logs ;;
  backup) run_scope backup ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
