-- Migration 018: Add train_checkpoint column to custom_models
-- Allows training jobs to resume from the last completed step after a crash.
-- Stores JSON: {"phase": "sft"|"dpo"|"merge"|"ollama", "step": N, "timestamp": "..."}
--
-- Also ensures the custom_models table exists (defensive against ghost
-- _migrations entries from previous failed deploys of 05/06/07 JS migrations).

-- Ensure custom_models table exists (idempotent, includes all columns from 05/06/07)
CREATE TABLE IF NOT EXISTS custom_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  model_name VARCHAR(255) NOT NULL,
  base_model_path VARCHAR(512) NOT NULL,
  dataset_path VARCHAR(512),
  data_source VARCHAR(50) DEFAULT 'file',
  db_connection_string TEXT,
  db_query TEXT,
  web_url TEXT,
  status VARCHAR(50) DEFAULT 'PENDING',
  output_dir VARCHAR(512),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add train_checkpoint column
ALTER TABLE custom_models
  ADD COLUMN IF NOT EXISTS train_checkpoint TEXT;
