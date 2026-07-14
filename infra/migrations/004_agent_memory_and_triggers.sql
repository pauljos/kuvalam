-- 004_agent_memory_and_triggers.sql
-- Long-term entity memory + ambient/proactive trigger conditions

-- ─── Agent Long-term Memory ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_memory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL,
  task_id         UUID REFERENCES agent_tasks(id) ON DELETE SET NULL,
  entity_type     TEXT NOT NULL,   -- PERSON, ORG, PRODUCT, DATE, LOCATION, CONCEPT, FACT
  entity_name     TEXT NOT NULL,
  detail          TEXT,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, entity_type, entity_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_agent_id ON agent_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_tenant_id ON agent_memory(tenant_id);

-- ─── Ambient / Proactive Triggers ─────────────────────────────────────────────
-- Allows workflows to be triggered by webhook events, DB conditions, or watch rules
CREATE TABLE IF NOT EXISTS workflow_triggers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('WEBHOOK', 'SCHEDULE', 'CONDITION', 'EVENT')),
  name            TEXT NOT NULL,
  -- For WEBHOOK: webhook secret stored here
  -- For SCHEDULE: cron expression
  -- For CONDITION: SQL-safe condition expression
  -- For EVENT: event_type string to listen for
  config          JSONB NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_fired_at   TIMESTAMPTZ,
  fire_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_triggers_tenant ON workflow_triggers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workflow_triggers_active ON workflow_triggers(is_active, trigger_type);
