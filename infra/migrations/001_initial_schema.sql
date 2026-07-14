-- ============================================================
-- Kuvalam Platform — Complete Database Schema
-- Migration: 001_initial_schema.sql
-- ============================================================

-- ─────────────────────────────────────────
-- PLATFORM LAYER
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255) NOT NULL,
  slug            VARCHAR(100) UNIQUE NOT NULL,
  plan            VARCHAR(50) NOT NULL DEFAULT 'TRIAL',
  status          VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  llm_config      JSONB DEFAULT '{}',
  settings        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           VARCHAR(255) UNIQUE NOT NULL,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash   VARCHAR(255),
  name            VARCHAR(255),
  mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret      VARCHAR(255),
  is_system_admin BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) UNIQUE NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

CREATE TABLE IF NOT EXISTS tenant_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            VARCHAR(50) NOT NULL DEFAULT 'VIEWER',
  status          VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  invited_by      UUID REFERENCES users(id),
  invite_token    VARCHAR(255),
  joined_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant ON tenant_members(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_members_user ON tenant_members(user_id);

-- ─────────────────────────────────────────
-- AGENT LAYER
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agents (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                  VARCHAR(255) NOT NULL,
  description           TEXT,
  archetype             VARCHAR(100),
  status                VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
  autonomy_level        VARCHAR(50) NOT NULL DEFAULT 'SUPERVISED',
  llm_provider          VARCHAR(100) DEFAULT 'openai',
  llm_model             VARCHAR(100) DEFAULT 'gpt-4o',
  system_prompt         TEXT,
  confidence_threshold  DECIMAL(3,2) DEFAULT 0.75,
  max_actions_per_run   INTEGER DEFAULT 20,
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_tenant ON agents(tenant_id, status);

CREATE TABLE IF NOT EXISTS agent_skills (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id              UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tenant_id             UUID NOT NULL,
  tool_connection_id    UUID,
  action_id             VARCHAR(255) NOT NULL DEFAULT 'http_request',
  name                  VARCHAR(255) NOT NULL,
  description           TEXT,
  requires_approval     BOOLEAN NOT NULL DEFAULT FALSE,
  is_enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  config                JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills(agent_id, is_enabled);

CREATE TABLE IF NOT EXISTS agent_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  rule_type   VARCHAR(50) NOT NULL DEFAULT 'GUARDRAIL',
  name        VARCHAR(255) NOT NULL,
  condition   JSONB NOT NULL DEFAULT '{}',
  enforcement VARCHAR(50) NOT NULL DEFAULT 'BLOCK',
  priority    INTEGER NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_rules_agent ON agent_rules(agent_id, is_active, priority);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL,
  goal            TEXT NOT NULL,
  context         JSONB DEFAULT '{}',
  priority        VARCHAR(50) DEFAULT 'MEDIUM',
  status          VARCHAR(50) NOT NULL DEFAULT 'QUEUED',
  plan            JSONB,
  actions         JSONB DEFAULT '[]',
  result          JSONB,
  error           TEXT,
  token_usage     JSONB DEFAULT '{"prompt":0,"completion":0,"total":0}',
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent ON agent_tasks(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_tenant ON agent_tasks(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_episodic_memory (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tenant_id      UUID NOT NULL,
  task_id        UUID REFERENCES agent_tasks(id),
  task_type      VARCHAR(255),
  goal_summary   TEXT NOT NULL,
  outcome        VARCHAR(50) NOT NULL,
  key_actions    JSONB DEFAULT '[]',
  result_summary TEXT,
  lessons        TEXT,
  embedding      vector(1536),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_episodic_agent ON agent_episodic_memory(agent_id, outcome);

-- ─────────────────────────────────────────
-- KNOWLEDGE LAYER
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             VARCHAR(255) NOT NULL,
  description      TEXT,
  embedding_model  VARCHAR(100) NOT NULL DEFAULT 'text-embedding-3-large',
  chunk_strategy   VARCHAR(50) NOT NULL DEFAULT 'PARAGRAPH',
  chunk_size       INTEGER DEFAULT 512,
  chunk_overlap    INTEGER DEFAULT 64,
  status           VARCHAR(50) NOT NULL DEFAULT 'READY',
  document_count   INTEGER DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_tenant ON knowledge_bases(tenant_id);

CREATE TABLE IF NOT EXISTS agent_knowledge_bases (
  agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, knowledge_base_id)
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL,
  name              VARCHAR(500) NOT NULL,
  source_type       VARCHAR(50) NOT NULL DEFAULT 'UPLOAD',
  source_url        TEXT,
  mime_type         VARCHAR(100),
  storage_path      TEXT,
  current_version   INTEGER NOT NULL DEFAULT 1,
  status            VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  chunk_count       INTEGER DEFAULT 0,
  file_size_bytes   BIGINT,
  metadata          JSONB DEFAULT '{}',
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_docs_kb ON knowledge_documents(knowledge_base_id, status);
CREATE INDEX IF NOT EXISTS idx_docs_tenant ON knowledge_documents(tenant_id);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  chunk_index   INTEGER NOT NULL,
  content       TEXT NOT NULL,
  token_count   INTEGER,
  metadata      JSONB DEFAULT '{}',
  status        VARCHAR(50) DEFAULT 'ACTIVE',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON knowledge_chunks(document_id, status);
CREATE INDEX IF NOT EXISTS idx_chunks_fts ON knowledge_chunks USING gin(to_tsvector('english', content));

CREATE TABLE IF NOT EXISTS knowledge_chunk_embeddings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id    UUID NOT NULL UNIQUE REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  embedding   vector(1536) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_hnsw
  ON knowledge_chunk_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ─────────────────────────────────────────
-- WORKFLOW LAYER
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  trigger     JSONB NOT NULL DEFAULT '{"type":"MANUAL"}',
  steps       JSONB NOT NULL DEFAULT '[]',
  on_failure  VARCHAR(50) DEFAULT 'STOP',
  timeout_seconds INTEGER DEFAULT 86400,
  version     INTEGER NOT NULL DEFAULT 1,
  status      VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflows_tenant ON workflows(tenant_id, status);

CREATE TABLE IF NOT EXISTS workflow_executions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id      UUID NOT NULL REFERENCES workflows(id),
  tenant_id        UUID NOT NULL,
  workflow_version INTEGER NOT NULL DEFAULT 1,
  status           VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  triggered_by     JSONB NOT NULL DEFAULT '{}',
  idempotency_key  VARCHAR(255),
  context          JSONB DEFAULT '{}',
  error            JSONB,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_idempotent
  ON workflow_executions(workflow_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_executions_workflow ON workflow_executions(workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_executions_tenant ON workflow_executions(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS step_executions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id    UUID NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL,
  step_id         VARCHAR(255) NOT NULL,
  step_type       VARCHAR(50) NOT NULL,
  status          VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  input           JSONB,
  output          JSONB,
  error           JSONB,
  retry_count     INTEGER DEFAULT 0,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  duration_ms     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_step_exec_execution ON step_executions(execution_id);

-- ─────────────────────────────────────────
-- TOOL INTEGRATION LAYER
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tool_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tool_id         VARCHAR(255) NOT NULL,
  name            VARCHAR(255) NOT NULL,
  status          VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  auth_type       VARCHAR(50) NOT NULL DEFAULT 'API_KEY',
  credential_ref  VARCHAR(500),
  config          JSONB DEFAULT '{}',
  last_tested_at  TIMESTAMPTZ,
  last_error      TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_connections_tenant ON tool_connections(tenant_id, status);

-- ─────────────────────────────────────────
-- HUMAN-IN-THE-LOOP LAYER
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  task_id         UUID REFERENCES agent_tasks(id),
  execution_id    UUID REFERENCES workflow_executions(id),
  step_id         VARCHAR(255),
  requested_by    VARCHAR(255) NOT NULL,
  assigned_to     UUID[] NOT NULL DEFAULT '{}',
  context         JSONB NOT NULL DEFAULT '{}',
  status          VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  deadline        TIMESTAMPTZ NOT NULL,
  risk_level      VARCHAR(50) DEFAULT 'MEDIUM',
  decision        VARCHAR(50),
  decided_by      UUID REFERENCES users(id),
  decision_note   TEXT,
  modified_input  JSONB,
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_tenant ON approval_requests(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_approval_deadline ON approval_requests(deadline) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS human_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  approval_id     UUID REFERENCES approval_requests(id),
  agent_id        UUID REFERENCES agents(id),
  decision        VARCHAR(50) NOT NULL,
  quality_rating  INTEGER CHECK (quality_rating BETWEEN 1 AND 5),
  feedback_text   TEXT,
  feedback_tags   TEXT[] DEFAULT '{}',
  decided_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- AUDIT LOG (append-only)
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID,
  event_type    VARCHAR(255) NOT NULL,
  actor_type    VARCHAR(50) NOT NULL DEFAULT 'SYSTEM',
  actor_id      VARCHAR(255),
  resource_type VARCHAR(100),
  resource_id   UUID,
  action        VARCHAR(255) NOT NULL,
  before_state  JSONB,
  after_state   JSONB,
  metadata      JSONB DEFAULT '{}',
  ip_address    INET,
  trace_id      VARCHAR(255),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(tenant_id, resource_type, resource_id);

-- ─────────────────────────────────────────
-- UTILITY FUNCTIONS
-- ─────────────────────────────────────────

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply to all tables with updated_at
CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_agents_updated_at BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_knowledge_bases_updated_at BEFORE UPDATE ON knowledge_bases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_knowledge_documents_updated_at BEFORE UPDATE ON knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_workflows_updated_at BEFORE UPDATE ON workflows
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_tool_connections_updated_at BEFORE UPDATE ON tool_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

SELECT 'Kuvalam schema v1 created successfully' AS status;
