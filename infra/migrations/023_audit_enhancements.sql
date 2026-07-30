-- 023_audit_enhancements.sql
-- Audit log performance index + LLM pricing configuration table
-- Adds:
--   1. Composite index (tenant_id, event_type, created_at) for analytics queries
--   2. llm_pricing_config table for admin-configurable model pricing
--   3. Periodic audit cleanup (via pg_cron or application-level cleanup)

-- ── 1. Performance index for event-type filtered queries ──────────────────
-- The analytics endpoint filters audit_log by event_type='llm.tokens_used'.
-- Without this index, it scans all rows in the tenant's 30-day window.
CREATE INDEX IF NOT EXISTS idx_audit_tenant_event_time
  ON audit_log(tenant_id, event_type, created_at DESC);

-- ── 2. LLM pricing configuration table ────────────────────────────────────
-- Admin-configurable pricing per model. Avoids hardcoded TOKEN_COST_PER_M
-- in analytics.routes.js that goes stale when providers change pricing.
CREATE TABLE IF NOT EXISTS llm_pricing_config (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID,                              -- NULL = global default pricing
  model_id    VARCHAR(255) NOT NULL,              -- e.g. 'gpt-4o', 'claude-3-5-sonnet'
  input_cost_per_million  NUMERIC(10,6) NOT NULL DEFAULT 0,  -- USD per 1M input tokens
  output_cost_per_million NUMERIC(10,6) NOT NULL DEFAULT 0,  -- USD per 1M output tokens
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_llm_pricing_model ON llm_pricing_config(model_id);
CREATE INDEX IF NOT EXISTS idx_llm_pricing_tenant ON llm_pricing_config(tenant_id) WHERE tenant_id IS NOT NULL;

-- Seed default pricing (matches current hardcoded values + newer models)
INSERT INTO llm_pricing_config (model_id, input_cost_per_million, output_cost_per_million) VALUES
  ('gpt-4o',              2.50,  10.00),
  ('gpt-4o-mini',         0.15,   0.60),
  ('gpt-4-turbo',        10.00,  30.00),
  ('gpt-3.5-turbo',       0.50,   1.50),
  ('gpt-4.1',             2.00,   8.00),
  ('o1',                 15.00,  60.00),
  ('o3-mini',             1.10,   4.40),
  ('o4-mini',             1.10,   4.40),
  ('claude-3-5-sonnet',   3.00,  15.00),
  ('claude-3-opus',      15.00,  75.00),
  ('claude-3-5-haiku',    0.80,   4.00),
  ('gemini-2.5-pro',      1.25,   5.00),
  ('gemini-2.5-flash',    0.15,   0.60),
  ('llama-3.1-70b',       0.59,   0.79),
  ('llama-3.1-405b',      2.20,   2.95),
  ('mixtral-8x22b',       0.65,   0.65),
  ('deepseek-v3',         0.27,   1.10)
ON CONFLICT (tenant_id, model_id) DO NOTHING;

-- ── 3. RLS for pricing config ─────────────────────────────────────────────
ALTER TABLE llm_pricing_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS llm_pricing_read ON llm_pricing_config;
CREATE POLICY llm_pricing_read ON llm_pricing_config
  FOR SELECT USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id')::uuid);

DROP POLICY IF EXISTS llm_pricing_admin_write ON llm_pricing_config;
CREATE POLICY llm_pricing_admin_write ON llm_pricing_config
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM tenant_members
      WHERE tenant_id = current_setting('app.current_tenant_id')::uuid
        AND user_id = current_setting('app.current_user_id')::uuid
        AND role = 'ADMIN'
    )
  );
