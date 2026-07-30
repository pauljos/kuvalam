-- 020_multi_db_support.sql
-- Multi-DB tool routing for custom models (Approach B)
-- Adds a junction table so one trained model can query multiple databases.
-- Existing single-DB models continue working unchanged.

CREATE TABLE IF NOT EXISTS custom_model_databases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id UUID NOT NULL REFERENCES custom_models(id) ON DELETE CASCADE,
  db_label TEXT NOT NULL,
  db_connection_string TEXT NOT NULL,
  db_type TEXT NOT NULL DEFAULT 'postgres',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cmd_model ON custom_model_databases(model_id);

-- ── Backfill: promote existing single-DB models into the junction table ──────
-- Every custom_model with a db_connection_string gets one row.
-- This ensures the new lookup path works for ALL models, old and new.
-- Gracefully skip if the source columns don't exist yet (idempotent).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'custom_models' AND column_name = 'db_connection_string'
  ) THEN
    INSERT INTO custom_model_databases (model_id, db_label, db_connection_string, db_type)
    SELECT id,
           COALESCE(NULLIF(split_part(model_name, '-', 1), ''), 'default'),
           db_connection_string,
           CASE WHEN data_source = 'nosql' THEN 'mongodb' ELSE 'postgres' END
    FROM custom_models
    WHERE db_connection_string IS NOT NULL
      AND db_connection_string != ''
      AND data_source IN ('database', 'nosql')
      AND NOT EXISTS (
        SELECT 1 FROM custom_model_databases cmd WHERE cmd.model_id = custom_models.id
      );
  END IF;
END $$;

-- ── RLS: tenant isolation via parent custom_models row ───────────────────────
ALTER TABLE custom_model_databases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS custom_model_databases_isolation ON custom_model_databases;
CREATE POLICY custom_model_databases_isolation ON custom_model_databases
  FOR ALL
  USING (
    model_id IN (
      SELECT id FROM custom_models
      WHERE tenant_id = (current_setting('app.current_tenant_id', true))::uuid
    )
  )
  WITH CHECK (
    model_id IN (
      SELECT id FROM custom_models
      WHERE tenant_id = (current_setting('app.current_tenant_id', true))::uuid
    )
  );
