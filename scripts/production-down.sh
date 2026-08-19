#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/lib/docker.sh"
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
cd "$ROOT"
"${DOCKER[@]}" compose --env-file "$ENV_FILE" -f compose.production.yml down --remove-orphans
