# Kuvalam — On-Prem Install

Run the full Kuvalam AI Agent Platform inside your organisation's network,
next to the databases and file shares your agents need to touch. Same product
as the SaaS build — same UI, same features — just deployed on your hardware.

## Why on-prem?

- **Data stays on-network.** Agents can query internal Postgres/MySQL,
  read Confluence/Sharepoint, hit intranet APIs that are not reachable from
  the public internet.
- **Local LLMs.** Point Kuvalam at Ollama, LM Studio, LocalAI, vLLM, or any
  OpenAI-compatible endpoint on your LAN. Zero data ever leaves the site.
- **Optional cloud LLMs.** Tenants can still configure OpenAI / Anthropic /
  OpenRouter per-tenant if a specific team wants that.

## Requirements

| Component | Minimum | Notes |
|---|---|---|
| OS | Linux (Ubuntu 22.04+, Debian 12, RHEL 9), macOS 13+ | Windows via WSL2 works too |
| CPU / RAM | 4 vCPU / 8 GB | 8 vCPU / 16 GB recommended if you also run an LLM on this box |
| Disk | 40 GB free | +space for your knowledge-base uploads |
| Docker | 24+ with the `compose` v2 plugin | https://docs.docker.com/engine/install/ |
| Network | Static IP or DNS name reachable by users' browsers | e.g. `kuvalam.acme.local` |
| LLM (optional, on separate box) | Ollama / LM Studio / LocalAI / vLLM | Can be same host or any LAN machine |

You do **not** need Node.js, Postgres or Redis installed on the host —
everything runs in containers.

## Install (5 minutes)

```bash
# 1. Get the code
git clone https://github.com/YOUR-ORG/kuvalam /opt/kuvalam
cd /opt/kuvalam

# 2. Run the installer — it prompts you for the admin password and
#    generates all secrets automatically.
./infra/onprem/install.sh
```

On first run the installer will:

1. Copy [infra/onprem/.env.example](.env.example) → `/opt/kuvalam/.env` and
   pause so you can edit `NEXT_PUBLIC_API_URL` / `FRONTEND_URL` to the IP
   or hostname of this machine.
2. Generate strong random values for `JWT_SECRET`, `COOKIE_SECRET`,
   `CREDENTIAL_ENCRYPTION_KEY` and `POSTGRES_PASSWORD`.
3. Prompt for the initial admin password.
4. Build the Docker images, run DB migrations, seed the first
   `OWNER` user + tenant, and start every service.

When it finishes you'll get a URL and login instructions. Open the Web UI,
sign in, and:

1. **Settings → LLM Providers** — configure your local model server.
   For Ollama on the same box as Kuvalam use `http://host.docker.internal:11434/v1`
   (Docker Desktop) or the host's LAN IP.
2. **Integrations → Add Database Connector** — point at your internal
   Postgres/MySQL so agents can run read-only queries.
3. **Integrations → Add MCP Server / API Key** — wire in Slack, Jira,
   internal HTTP APIs, etc.
4. **Agents → + Create Agent** — pick the provider + model you just
   configured; different agents can use different models.

## Day-2 operations

```bash
# Upgrade to the latest version
./infra/onprem/update.sh

# Take a backup (postgres + redis + uploaded files → ./backups/)
./infra/onprem/backup.sh

# Tail logs
docker compose -f infra/docker/docker-compose.prod.yml logs -f api worker

# Restart everything
docker compose -f infra/docker/docker-compose.prod.yml restart
```

Backups are just `pg_dump` files — copy them to your existing backup
target (NAS, S3, Veeam, tape).

## Network topology

```
┌───────────────────────────────────────────────────────────────┐
│                     Your Corporate LAN                        │
│                                                               │
│  ┌────────────┐    ┌────────────────┐    ┌───────────────┐    │
│  │  User      │    │  Kuvalam Host  │    │  LLM Host     │    │
│  │  browsers  │───▶│  (this box)    │───▶│  (Ollama /    │    │
│  │  :3000     │    │  api :3001     │    │   LM Studio)  │    │
│  └────────────┘    │  web :3000     │    │  :11434       │    │
│                    │  postgres      │    └───────────────┘    │
│                    │  redis         │                         │
│                    │  worker        │    ┌───────────────┐    │
│                    └────────────────┘───▶│  Your DB /    │    │
│                                          │  APIs / MCP   │    │
│                                          └───────────────┘    │
└───────────────────────────────────────────────────────────────┘
```

Only the Kuvalam host needs to be reachable from user browsers. The LLM
box and your internal databases only need to be reachable from the
Kuvalam host — they never talk to the browser.

## Security notes

- **All secrets are encrypted at rest** with `CREDENTIAL_ENCRYPTION_KEY`
  (AES-256-GCM). This includes LLM API keys, OAuth tokens, connector
  passwords, and DB connector passwords.
- **DB connectors are read-only** by construction — the SQL parser rejects
  every statement that is not `SELECT` / `WITH ... SELECT`. See
  [database-connector.service.js](../../apps/api/src/services/database-connector.service.js).
- **Private-IP SSRF guard** on all outbound tool calls in production
  (`NODE_ENV=production`). To let agents reach private-network URLs, mark
  the connector as `allow_private_host: true`.
- **RLS on every tenant table** — see
  [002_rls_policies.sql](../migrations/002_rls_policies.sql).
- **Never change `CREDENTIAL_ENCRYPTION_KEY`** after data is stored — all
  encrypted rows would become undecryptable. Rotate JWT/cookie secrets
  freely; encryption key is a one-way commitment.

## Same product, two deploy targets

The exact same code powers:

- **Cloud SaaS** — deploy via [render.yaml](../../render.yaml) in one click.
- **On-prem** — the flow above.

The only difference is where Postgres, Redis and the object store live.
No features are gated per deploy target.
