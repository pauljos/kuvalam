-- Migration 032: Row-Level Security for supervisor tables
-- Follow-up to 031: enable RLS + tenant policies on agent_health and tenant_memory.
-- Idempotent (uses IF NOT EXISTS / DROP POLICY IF EXISTS).

BEGIN;

-- ─── agent_health ──────────────────────────────────────────────────────────
ALTER TABLE agent_health ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_health_tenant_isolation ON agent_health;
CREATE POLICY agent_health_tenant_isolation ON agent_health
  USING (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS agent_health_tenant_insert ON agent_health;
CREATE POLICY agent_health_tenant_insert ON agent_health
  FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- ─── tenant_memory ─────────────────────────────────────────────────────────
ALTER TABLE tenant_memory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_memory_tenant_isolation ON tenant_memory;
CREATE POLICY tenant_memory_tenant_isolation ON tenant_memory
  USING (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS tenant_memory_tenant_insert ON tenant_memory;
CREATE POLICY tenant_memory_tenant_insert ON tenant_memory
  FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

COMMIT;
