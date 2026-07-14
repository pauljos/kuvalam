#!/usr/bin/env bash
# infra/onprem/update.sh
# Pull latest code, rebuild images, run migrations, restart services.
# Safe to run any time — migrations are idempotent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infra/docker/docker-compose.prod.yml"
ENV_FILE="$REPO_ROOT/.env"

log() { printf "\n\033[1;32m▶ %s\033[0m\n" "$*"; }

if [[ ! -f "$ENV_FILE" ]]; then
  echo "✗ .env not found — run install.sh first" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

log "Fetching latest source"
git -C "$REPO_ROOT" pull --ff-only

log "Rebuilding images"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build

log "Running migrations"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm \
  -e DATABASE_URL="postgres://${POSTGRES_USER:-kuvalam}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-kuvalam_db}" \
  api node src/db/migrate.js

log "Restarting services (zero-downtime rolling)"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-deps api worker web

log "Update complete."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
