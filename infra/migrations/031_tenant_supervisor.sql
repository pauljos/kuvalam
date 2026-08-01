-- Migration 031: Tenant Supervisor + Fleet Health + Shared Memory + Runtime Ceilings
-- Implements gaps G1, G2, G3, G4, G5 from architecture review.
--
--   G1  Tenant Supervisor loop: needs agent_health + is_supervisor flag on agents
--   G2  Runtime ceilings: per-agent max_tool_calls_per_minute, max_cost_usd_per_task,
--       max_wallclock_seconds
--   G3  Cross-agent shared memory: tenant_memory table
--   G4  agent_health telemetry table (fleet dashboard + circuit breaker)
--   G5  Supervisor-initiated HITL: extend approval_requests.reason
--
-- Safe/idempotent (uses IF NOT EXISTS) so it can be re-run.

BEGIN;

-- ─── G2: Per-agent runtime ceilings ─────────────────────────────────────────
-- All NULL-safe: NULL means "no limit" (backward-compatible).
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS max_tool_calls_per_minute INTEGER,
  ADD COLUMN IF NOT EXISTS max_cost_usd_per_task     NUMERIC(10, 4),
  ADD COLUMN IF NOT EXISTS max_wallclock_seconds     INTEGER;

-- ─── G1: Mark one agent per tenant as the tenant supervisor ────────────────
-- Only one supervisor allowed per tenant; enforced by a partial unique index.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS is_tenant_supervisor BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_one_supervisor_per_tenant
  ON agents (tenant_id)
  WHERE is_tenant_supervisor = TRUE;

-- ─── G4: Agent fleet health telemetry ──────────────────────────────────────
-- Populated by the supervisor loop every tick. Used by the UI fleet dashboard
-- and by the supervisor itself for circuit breaking.
CREATE TABLE IF NOT EXISTS agent_health (
  agent_id             UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  last_task_at         TIMESTAMPTZ,
  last_success_at      TIMESTAMPTZ,
  last_failure_at      TIMESTAMPTZ,
  running_tasks        INTEGER NOT NULL DEFAULT 0,
  completed_24h        INTEGER NOT NULL DEFAULT 0,
  failed_24h           INTEGER NOT NULL DEFAULT 0,
  cancelled_24h        INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms       INTEGER,
  avg_cost_usd         NUMERIC(10, 4),
  circuit_state        VARCHAR(20) NOT NULL DEFAULT 'CLOSED',    -- CLOSED | OPEN | HALF_OPEN
  circuit_reason       TEXT,
  circuit_opened_at    TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_health_tenant
  ON agent_health(tenant_id, circuit_state);

-- ─── G3: Tenant-shared memory (cross-agent facts) ──────────────────────────
-- Optional shared entity store: any agent with the 'shared_memory' scope can
-- read; only the tenant supervisor + explicit writers may write.
CREATE TABLE IF NOT EXISTS tenant_memory (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type    VARCHAR(50) NOT NULL,
  entity_name    VARCHAR(500) NOT NULL,
  detail         TEXT,
  source_agent   UUID REFERENCES agents(id) ON DELETE SET NULL,
  source_task    UUID,
  visibility     VARCHAR(20) NOT NULL DEFAULT 'TENANT',  -- TENANT | PRIVATE
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, entity_type, entity_name)
);

CREATE INDEX IF NOT EXISTS idx_tenant_memory_search
  ON tenant_memory USING GIN (
    to_tsvector('english', entity_name || ' ' || COALESCE(detail, ''))
  );

CREATE INDEX IF NOT EXISTS idx_tenant_memory_tenant
  ON tenant_memory(tenant_id, last_seen_at DESC);

-- ─── G5: Supervisor-initiated approvals ────────────────────────────────────
-- Allow supervisor to raise an approval request without a specific tool call.
-- We extend the existing approval_requests table with two nullable columns.
-- (approval_requests table lives in migration 015; nothing else needs changing.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_name = 'approval_requests') THEN
    -- initiator: 'AGENT' (default, existing behaviour) or 'SUPERVISOR'
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'approval_requests'
                   AND column_name = 'initiator') THEN
      ALTER TABLE approval_requests
        ADD COLUMN initiator VARCHAR(20) NOT NULL DEFAULT 'AGENT';
    END IF;

    -- Free-text supervisor reason ("agent looping on runQuery for 12 min")
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'approval_requests'
                   AND column_name = 'supervisor_reason') THEN
      ALTER TABLE approval_requests ADD COLUMN supervisor_reason TEXT;
    END IF;
  END IF;
END$$;

COMMIT;
