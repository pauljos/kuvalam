#!/usr/bin/env bash
# infra/onprem/install.sh
# One-command installer for on-prem Kuvalam.
#
# What this does:
#   1. Checks that docker + docker compose are installed.
#   2. Copies .env.example → .env if .env doesn't exist yet.
#   3. Generates strong random values for JWT_SECRET, COOKIE_SECRET,
#      CREDENTIAL_ENCRYPTION_KEY and POSTGRES_PASSWORD if any are blank.
#   4. Prompts for ADMIN_PASSWORD if not set.
#   5. Builds and starts the stack (postgres, redis, api, worker, web).
#   6. Runs DB migrations.
#   7. Bootstraps the first OWNER user + tenant.
#   8. Prints login instructions.
#
# Safe to run more than once — existing secrets are preserved, migrations
# and bootstrap are both idempotent.
#
# Usage:
#   cd /opt/kuvalam
#   ./infra/onprem/install.sh
set -euo pipefail

# Resolve repo root regardless of where the script is called from
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infra/docker/docker-compose.prod.yml"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"

log()  { printf "\n\033[1;32m▶ %s\033[0m\n" "$*"; }
warn() { printf "\n\033[1;33m! %s\033[0m\n" "$*"; }
err()  { printf "\n\033[1;31m✗ %s\033[0m\n" "$*" >&2; }

# ── 1. Preflight ─────────────────────────────────────────────────────────────
log "Checking prerequisites"
command -v docker >/dev/null 2>&1 || { err "docker is required (https://docs.docker.com/engine/install/)"; exit 1; }
docker compose version >/dev/null 2>&1 || { err "docker compose v2 plugin is required"; exit 1; }
command -v openssl >/dev/null 2>&1 || { err "openssl is required to generate secrets"; exit 1; }
echo "  docker $(docker --version | awk '{print $3}' | tr -d ',')"
echo "  docker compose $(docker compose version --short 2>/dev/null || echo unknown)"

# ── 2. Create .env if missing ────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  log "Creating .env from template"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo "  → $ENV_FILE"
  warn "Edit .env to set NEXT_PUBLIC_API_URL / FRONTEND_URL to the IP or hostname of THIS machine before continuing."
  read -r -p "Press Enter after you have edited .env, or Ctrl+C to abort..." _
fi

# ── 3. Generate any missing secrets ──────────────────────────────────────────
log "Generating missing secrets"
generate_if_blank() {
  local key="$1"
  local current
  current="$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  if [[ -z "$current" ]]; then
    local value
    value="$(openssl rand -hex 32)"
    # macOS sed vs GNU sed compatibility
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
      sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    fi
    echo "  ✓ ${key}"
  else
    echo "  · ${key} (already set)"
  fi
}
generate_if_blank JWT_SECRET
generate_if_blank COOKIE_SECRET
generate_if_blank CREDENTIAL_ENCRYPTION_KEY
generate_if_blank POSTGRES_PASSWORD

# ── 4. Admin password ────────────────────────────────────────────────────────
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
  log "Set the initial administrator password"
  echo "  Email: ${ADMIN_EMAIL:-<unset — edit .env first>}"
  while true; do
    read -r -s -p "  Password (min 8 chars): " pw1; echo
    read -r -s -p "  Confirm password:       " pw2; echo
    if [[ "$pw1" != "$pw2" ]];  then warn "Passwords did not match — try again."; continue; fi
    if [[ ${#pw1} -lt 8 ]];     then warn "Password too short — try again.";      continue; fi
    break
  done
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${pw1}|" "$ENV_FILE"
  else
    sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${pw1}|" "$ENV_FILE"
  fi
  ADMIN_PASSWORD="$pw1"
fi

# ── 5. Sanity-check required vars ────────────────────────────────────────────
: "${NEXT_PUBLIC_API_URL:?NEXT_PUBLIC_API_URL must be set in .env}"
: "${FRONTEND_URL:?FRONTEND_URL must be set in .env}"
: "${ADMIN_EMAIL:?ADMIN_EMAIL must be set in .env}"
: "${TENANT_NAME:?TENANT_NAME must be set in .env}"
: "${TENANT_SLUG:?TENANT_SLUG must be set in .env}"

# ── 6. Build & start the stack ───────────────────────────────────────────────
log "Building images (this may take a few minutes on first run)"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build

log "Starting postgres + redis"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d postgres redis

log "Waiting for postgres to be healthy"
for _ in {1..30}; do
  if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps postgres | grep -q "healthy"; then
    echo "  ✓ postgres ready"
    break
  fi
  sleep 2
done

# ── 7. Run migrations ────────────────────────────────────────────────────────
log "Running database migrations"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm \
  -e DATABASE_URL="postgres://${POSTGRES_USER:-kuvalam}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-kuvalam_db}" \
  api node src/db/migrate.js

# ── 8. Bootstrap admin ───────────────────────────────────────────────────────
log "Bootstrapping first admin user + tenant"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm \
  -e DATABASE_URL="postgres://${POSTGRES_USER:-kuvalam}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-kuvalam_db}" \
  -e ADMIN_EMAIL="$ADMIN_EMAIL" \
  -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -e ADMIN_NAME="${ADMIN_NAME:-Administrator}" \
  -e TENANT_NAME="$TENANT_NAME" \
  -e TENANT_SLUG="$TENANT_SLUG" \
  api node src/db/bootstrap_admin.js

# ── 9. Start api + worker + web ──────────────────────────────────────────────
log "Starting application services"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d api worker web

# ── 10. Done ─────────────────────────────────────────────────────────────────
cat <<EOF

──────────────────────────────────────────────────────────────────────
  Kuvalam is up.

  Web UI:      $FRONTEND_URL
  API:         $NEXT_PUBLIC_API_URL/health
  Sign in as:  $ADMIN_EMAIL

  Next steps:
    1. Open the Web UI and sign in.
    2. Go to Settings → LLM Providers and configure your local model
       server (Ollama / LM Studio / LocalAI / custom OpenAI-compatible).
    3. Go to Integrations → add your organisation's database(s) as
       Postgres connectors so agents can query them read-only.
    4. Create your first Agent (Agents → + Create Agent).

  Ops:
    ./infra/onprem/update.sh   — pull latest, migrate, restart
    ./infra/onprem/backup.sh   — dump postgres + uploaded files
    docker compose -f $COMPOSE_FILE logs -f api
──────────────────────────────────────────────────────────────────────
EOF
