-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 033: Shared Tenant Memory
-- A knowledge store shared across ALL agents in a tenant — unlike agent_memory
-- which is per-agent. Agents can read/write to this shared pool, making
-- discoveries and facts available to every agent in the organisation.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_shared_memory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key             VARCHAR(500) NOT NULL,
  value           TEXT NOT NULL,
  category        VARCHAR(100) NOT NULL DEFAULT 'GENERAL',
  -- Which agent wrote this entry (NULL = written by a human via UI)
  agent_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
  task_id         UUID REFERENCES agent_tasks(id) ON DELETE SET NULL,
  source          VARCHAR(50) NOT NULL DEFAULT 'AGENT', -- AGENT | HUMAN | SYSTEM
  -- Optional expiry — NULL means permanent
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One key per tenant (upsert-safe)
  UNIQUE(tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_tsm_tenant ON tenant_shared_memory(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tsm_category ON tenant_shared_memory(tenant_id, category);
CREATE INDEX IF NOT EXISTS idx_tsm_agent ON tenant_shared_memory(agent_id);

-- Full-text search index for retrieval by goal similarity
CREATE INDEX IF NOT EXISTS idx_tsm_fts ON tenant_shared_memory
  USING gin(to_tsvector('english', key || ' ' || value));

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_tenant_shared_memory_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tsm_updated_at ON tenant_shared_memory;
CREATE TRIGGER trg_tsm_updated_at
  BEFORE UPDATE ON tenant_shared_memory
  FOR EACH ROW EXECUTE FUNCTION update_tenant_shared_memory_updated_at();

-- Row Level Security
ALTER TABLE tenant_shared_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tsm_tenant_isolation ON tenant_shared_memory;
CREATE POLICY tsm_tenant_isolation ON tenant_shared_memory
  USING (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS tsm_tenant_insert ON tenant_shared_memory;
CREATE POLICY tsm_tenant_insert ON tenant_shared_memory
  FOR INSERT WITH CHECK (tenant_id = current_tenant_id());
