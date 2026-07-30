-- 024_agent_triggers.sql
-- Support triggers that target agents directly (not just workflows)
-- Adds:
--   1. target_type column ('WORKFLOW' | 'AGENT')
--   2. Make workflow_id nullable
--   3. agent_id + agent_prompt columns for agent-targeted triggers

-- ── 1. Add target_type column ────────────────────────────────────────────
ALTER TABLE workflow_triggers
  ADD COLUMN IF NOT EXISTS target_type VARCHAR(20) NOT NULL DEFAULT 'WORKFLOW';

-- ── 2. Make workflow_id nullable ─────────────────────────────────────────
ALTER TABLE workflow_triggers
  ALTER COLUMN workflow_id DROP NOT NULL;

-- ── 3. Add agent columns ─────────────────────────────────────────────────
ALTER TABLE workflow_triggers
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS agent_prompt TEXT;

-- ── 4. Add check constraint ──────────────────────────────────────────────
-- Ensure exactly one target type is set
ALTER TABLE workflow_triggers
  DROP CONSTRAINT IF EXISTS workflow_triggers_target_check;

ALTER TABLE workflow_triggers
  ADD CONSTRAINT workflow_triggers_target_check
  CHECK (
    (target_type = 'WORKFLOW' AND workflow_id IS NOT NULL AND agent_id IS NULL) OR
    (target_type = 'AGENT' AND agent_id IS NOT NULL AND workflow_id IS NULL)
  );

-- ── 5. Index for agent lookups ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_workflow_triggers_agent
  ON workflow_triggers(agent_id) WHERE agent_id IS NOT NULL;

-- ── 6. Update RLS policy to include agent_id ─────────────────────────────
-- The existing tenant isolation policy uses workflow_id IN (SELECT id FROM workflows WHERE tenant_id = ...)
-- For agent triggers, we need a broader policy
DROP POLICY IF EXISTS workflow_triggers_tenant_isolation ON workflow_triggers;
CREATE POLICY workflow_triggers_tenant_isolation ON workflow_triggers
  USING (
    tenant_id = current_setting('app.current_tenant_id')::uuid
  );

-- ── 7. Update trigger type check to include AGENT_SCHEDULE ───────────────
ALTER TABLE workflow_triggers
  DROP CONSTRAINT IF EXISTS workflow_triggers_trigger_type_check;

ALTER TABLE workflow_triggers
  ADD CONSTRAINT workflow_triggers_trigger_type_check
  CHECK (trigger_type = ANY (ARRAY['WEBHOOK'::text, 'SCHEDULE'::text, 'CONDITION'::text, 'EVENT'::text, 'AGENT_SCHEDULE'::text]));