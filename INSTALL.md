# Kuvalam — Installation Guide

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | ≥ 20 | via [nvm](https://github.com/nvm-sh/nvm) or [official](https://nodejs.org) |
| **Python** | ≥ 3.10 | 3.13 recommended; needed for LLM training |
| **Docker** | ≥ 24 | [Docker Desktop](https://docker.com) or [OrbStack](https://orbstack.dev) |
| **Ollama** | latest | [ollama.com](https://ollama.com) — local LLM inference |
| **Git** | latest | |

Optional but recommended:
- **GPU + CUDA** — dramatically faster training (NVIDIA + CUDA 12.x)
- **Homebrew** — macOS package manager (`brew install node python`)

---

## 1. Clone the Repository

```bash
git clone https://github.com/<your-org>/kuvalam.git
cd kuvalam
```

---

## 2. Install Node.js Dependencies

The project uses npm workspaces (monorepo). Run this **once** from the root:

```bash
npm install
```

This installs dependencies for all apps (`apps/api`, `apps/web`, `apps/worker`) and shared packages (`packages/shared`) automatically.

---

## 3. Python Environment (for LLM Training)

Create a virtual environment and install the ML stack:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### CPU-only (macOS / no GPU)

```bash
pip install --upgrade pip
pip install torch transformers peft trl datasets accelerate \
  safetensors pandas sqlalchemy psycopg2-binary
```

### GPU / CUDA (NVIDIA — recommended for production)

```bash
pip install --upgrade pip
# CUDA 12.x torch (faster training)
pip install torch --index-url https://download.pytorch.org/whl/cu124
pip install unsloth  # enables fast LoRA + GGUF export
pip install transformers peft trl datasets accelerate \
  safetensors pandas sqlalchemy psycopg2-binary
```

> ⚠️ The training pipeline auto-detects your setup:
> - **CUDA available** → uses Unsloth (fast GPU training + GGUF export)
> - **MPS available** (Apple Silicon) → uses CPU/PyTorch training path (no Unsloth)
> - **CPU only** → uses standard transformers + PEFT + TRL (slower, works for ≤2B models)

> 📦 **TRL version note:** This project requires TRL ≥ 1.0 (tested with 1.9.0).
> The API uses `processing_class` instead of `tokenizer`, `SFTConfig` instead of `TrainingArguments`,
> and `peft_config` is passed directly to `SFTTrainer` (no manual `get_peft_model`).

> 🔑 For faster HuggingFace model downloads, set a HF token:
> ```bash
> export HF_TOKEN=hf_your_token_here
> ```

### Verify the installation

```bash
source .venv/bin/activate
python -c "import torch; print(f'torch {torch.__version__}, cuda={torch.cuda.is_available()}')"
python -c "import transformers, peft, trl, datasets; print('All deps OK')"
python -c "import psycopg2; print('psycopg2 OK')"
```

---

## 4. Infrastructure (Docker)

Start PostgreSQL (with pgvector), Redis, and MailDev:

```bash
# From the project root — starts core services
docker compose up -d
```

### What runs in Docker

| Service | Container Name | Port | Purpose |
|---------|---------------|------|---------|
| PostgreSQL 16 + pgvector | `kuvalam-postgres` | 5434 | Primary database + vector embeddings |
| Redis 7 | `kuvalam-redis` | 6380 | Job queue, caching, session store |
| MailDev | `kuvalam-maildev` | 1025 / 1080 | SMTP test server + web UI |

### Knowledge Graph (Neo4j — optional)

Neo4j powers the Knowledge Graphs tab for entity-relationship traversal. It's optional and started with the `graph` profile:

```bash
docker compose --profile graph up -d
```

| Service | Container Name | Port | Purpose |
|---------|---------------|------|---------|
| Neo4j 5 | `kuvalam-neo4j` | 7474 / 7687 | Graph database (HTTP / Bolt) |

---

## 5. Database Setup

```bash
# Run migrations (creates all tables, RLS policies, indexes)
cd apps/api
npm run migrate

# (Optional) Seed demo data
npm run seed

cd ../..
```

---

## 6. Environment Configuration

Copy the example env file and edit it:

```bash
cp .env.example .env
```

Edit the following variables at minimum:

```env
# ── Database ─────────────────────────────
# Default user/password match docker-compose.yml
DATABASE_URL=postgresql://kuvalam:axon_dev_password@localhost:5434/kuvalam_db

# ── Redis ────────────────────────────────
REDIS_URL=redis://localhost:6380

# ── JWT ──────────────────────────────────
# Generate with: openssl rand -hex 32
JWT_SECRET=your-random-secret-at-least-32-chars

# ── Credential encryption ────────────────
# Generate with: openssl rand -hex 32
CREDENTIAL_ENCRYPTION_KEY=your-random-key-at-least-32-chars

# ── LLM Provider ─────────────────────────
OPENAI_API_KEY=sk-...

# ── Frontend URL ─────────────────────────
FRONTEND_URL=http://localhost:3000

# ── Knowledge Infrastructure (auto-detected, override if needed) ──
# Container names must match what's running. Override if your containers
# have different names (e.g. from an older docker-compose.yml):
# K8_PGVECTOR_CONTAINER=kuvalam-postgres
# K8_NEO4J_CONTAINER=kuvalam-neo4j
```

> ℹ️ See `.env.example` for all available variables.

### Knowledge Infrastructure env vars

| Variable | Default | Purpose |
|----------|---------|---------|
| `K8_PGVECTOR_CONTAINER` | `kuvalam-postgres` | pgvector Docker container name |
| `K8_NEO4J_CONTAINER` | `kuvalam-neo4j` | Neo4j Docker container name |
| `K8_PG_COMPOSE_SERVICE` | `postgres` | docker-compose service name for postgres |
| `K8_NEO4J_COMPOSE_SERVICE` | `neo4j` | docker-compose service name for neo4j |
| `K8_AUTO_PROVISION` | (enabled) | Set to `false` to disable startup auto-provisioning |
| `K8_AUTO_PROVISION_NEO4J` | (enabled) | Set to `false` to skip Neo4j auto-start |

---

## 7. Knowledge Infrastructure (Auto-Provisioning)

The API automatically detects and provisions knowledge backends on startup. This means **zero manual setup** for Knowledge Bases and Graphs:

### What happens automatically

When the API server starts (in development mode), it:

1. **Checks Docker** — verifies the Docker daemon is running
2. **Ensures containers** — starts pgvector container if not running; starts Neo4j if not running (best-effort, Neo4j is optional)
3. **Creates connectors** — registers `tool_connections` records for every active tenant so Knowledge Bases (vector search) and Knowledge Graphs (entity traversal) work immediately
4. **Is idempotent** — on restart, skips tenants that already have active connectors

### System Scan

Go to **Settings → System Scan** and click "Run System Scan" to verify your setup. It checks:

- **Binary dependencies** — Node.js, npm, Python, pip, Git, Docker, Ollama, GPU, psql, redis-cli
- **Runtime services** — Ollama models, Browser Agent (Playwright), Docker containers
- **Knowledge infrastructure** — pgvector container health (with pgvector extension check), Neo4j container health (with HTTP endpoint check)
- **System resources** — disk space, total memory

Missing dependencies show install commands specific to your OS (macOS `brew` / Linux `apt`).

---

## 8. Run the Development Servers

### Start everything (API + Web + Worker)

```bash
# From the project root — starts API (port 3001) and Web (port 3000) concurrently
npm run dev
```

### Start individually

```bash
# API only
npm run dev:api       # http://localhost:3001

# Web only
npm run dev:web       # http://localhost:3000

# Worker only (job processing)
npm run dev:worker
```

### Verify it's running

```bash
curl http://localhost:3001/health
# → {"status":"ok",...}
```

Open [http://localhost:3000](http://localhost:3000) in your browser. The API startup logs will show:

```
📋 Knowledge Infra Auto-Provision Summary:
   Docker:      ✅ available
   pgvector:    ✅ running & connected
   Neo4j:       ✅ running & connected
```

---

## 9. Install Ollama (Local LLM Inference)

[Download Ollama](https://ollama.com) or use Homebrew:

```bash
brew install --cask ollama
```

Pull at least one model for testing:

```bash
ollama pull qwen2.5:0.5b      # Small, fast (for testing)
# or
ollama pull llama3.2:1b
```

Ollama must be running on `http://localhost:11434` for the training pipeline and chat features.

---

## 10. Custom LLM Training

The platform supports fine-tuning models on your own data:

1. Go to **Settings → Custom Models** in the dashboard
2. Click **Create Custom Model**
3. Select a base model (e.g. `qwen2.5:0.5b`)
4. Choose a data source (database, file, or web URL)
5. Click **Train**

**Training pipeline flow:**
- Validates model size — blocks models >2B params if no GPU is available
- Extracts data from your source (database query, file, or web scrape)
- Runs LoRA fine-tuning (Unsloth on GPU, transformers+PEFT+TRL on CPU)
- Pushes the trained model to Ollama for inference

**Trained models are available via:**
- Ollama API: `http://localhost:11434/api/generate`
- OpenAI-compatible endpoint: `http://localhost:3001/api/v1/chat/completions`

---

## 11. Deploy to Production

### Render (cloud — recommended)

The repo includes a `render.yaml` blueprint. Deploy with one click:

1. Push the repo to GitHub
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**
3. Connect your repo
4. Fill in prompted secrets (API keys, DB password, etc.)
5. After first deploy, run migrations once:
   ```
   node src/db/migrate.js
   ```

### Docker (self-hosted)

```bash
# Build and start all production services
docker compose -f infra/docker/docker-compose.prod.yml up -d --build

# Run migrations on the production DB
npm run prod:migrate
```

---

## 12. Project Structure

```
kuvalam/
├── apps/
│   ├── api/          # Fastify REST API (port 3001)
│   ├── web/          # Next.js dashboard (port 3000)
│   └── worker/       # BullMQ background job worker
├── packages/
│   └── shared/       # Shared types, utils, constants
├── infra/
│   ├── docker/       # Production Docker Compose files
│   ├── migrations/   # SQL migration files
│   └── onprem/       # On-premise deployment scripts
├── artifacts/        # Generated artifacts (reports, etc.)
├── downloads/        # Downloaded files (training data, etc.)
├── docker-compose.yml   # Development Docker Compose (root level)
├── render.yaml       # Render Blueprint config
└── INSTALL.md        # This file
```

---

## Quick Reference

```bash
# First-time setup (macOS / dev machine)
git clone <repo> && cd kuvalam
npm install
python3 -m venv .venv && source .venv/bin/activate
pip install torch transformers peft trl datasets accelerate safetensors pandas sqlalchemy psycopg2-binary
cp .env.example .env                          # then edit .env with your values
docker compose up -d                          # starts postgres, redis, maildev
cd apps/api && npm run migrate && npm run seed && cd ../..
# Optional: Knowledge Graph
docker compose --profile graph up -d          # starts neo4j
npm run dev
```

```bash
# First-time setup (GPU / production machine)
git clone <repo> && cd kuvalam
npm install
python3 -m venv .venv && source .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cu124
pip install unsloth transformers peft trl datasets accelerate safetensors pandas sqlalchemy psycopg2-binary
cp .env.example .env                          # then edit .env
docker compose up -d
cd apps/api && npm run migrate && cd ../..
npm run dev
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `python3` not found | Install Python 3.10+ from python.org or `brew install python` |
| Docker services won't start | Check Docker is running; use `docker compose up -d` (root-level compose file) |
| `docker compose` not found | Update Docker Desktop / Docker Engine to ≥ 24 |
| Ollama connection refused | Ensure Ollama is running (`ollama serve` or open the app) |
| Training fails with CUDA error | Install CUDA-compatible torch: see GPU section above |
| Training exits in 5 seconds | Make sure `.venv` has torch installed and `node --watch` restarted |
| Port 3001 in use | Kill existing process: `lsof -ti:3001 \| xargs kill` |
| Port 5434 in use | Check for another PostgreSQL instance; stop it or change the port in docker-compose.yml and .env |
| Database migration fails | Check `DATABASE_URL` in `.env` and that PostgreSQL is running |
| Auto-provisioning skipped containers | Ensure Docker daemon is running; check `docker ps` for container status |
| Neo4j not auto-provisioned | Run `docker compose --profile graph up -d` first; Neo4j is optional |
| Knowledge Backends show "No backends" | Restart the API — auto-provisioning runs on startup; check logs for errors |
| "pgvector extension not loaded" in System Scan | Container is running but pgvector isn't installed in that Postgres image; use `pgvector/pgvector:16-pgdg` |
| Container name mismatch errors | Set `K8_PGVECTOR_CONTAINER`, `K8_NEO4J_CONTAINER` in `.env` to match your container names |
| Disable auto-provisioning | Set `K8_AUTO_PROVISION=false` in `.env` and restart |
