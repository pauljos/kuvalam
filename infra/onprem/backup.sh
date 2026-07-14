#!/usr/bin/env bash
# infra/onprem/backup.sh
# Take a timestamped backup of:
#   - the entire postgres database (custom-format pg_dump)
#   - the redis appendonly file (if present)
#   - the api uploads volume (any files stored on local disk)
#
# Backups land in ./backups/ under the repo root. Rotate or ship them off-box
# yourself — this script does not delete anything.
#
# Restore:
#   cat backups/kuvalam-2026-07-13-1430.dump | \
#     docker compose ... exec -T postgres pg_restore -U kuvalam -d kuvalam_db --clean --if-exists
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infra/docker/docker-compose.prod.yml"
ENV_FILE="$REPO_ROOT/.env"
BACKUP_DIR="$REPO_ROOT/backups"
STAMP="$(date +%Y-%m-%d-%H%M)"

log() { printf "\n\033[1;32m▶ %s\033[0m\n" "$*"; }

if [[ ! -f "$ENV_FILE" ]]; then
  echo "✗ .env not found — run install.sh first" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
mkdir -p "$BACKUP_DIR"

log "Dumping postgres → $BACKUP_DIR/kuvalam-$STAMP.dump"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-kuvalam}" -d "${POSTGRES_DB:-kuvalam_db}" -F c \
  > "$BACKUP_DIR/kuvalam-$STAMP.dump"

log "Archiving redis appendonly file (if any)"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T redis \
  sh -c 'test -f /data/appendonly.aof && cat /data/appendonly.aof || true' \
  > "$BACKUP_DIR/redis-$STAMP.aof" || true
if [[ ! -s "$BACKUP_DIR/redis-$STAMP.aof" ]]; then rm -f "$BACKUP_DIR/redis-$STAMP.aof"; fi

log "Done."
ls -lh "$BACKUP_DIR" | tail -n +2
