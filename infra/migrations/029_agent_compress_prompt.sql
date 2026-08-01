-- Migration 029: per-agent system prompt compression toggle
-- When compress_system_prompt = TRUE the runtime summarises the full system
-- prompt via the LLM before each task call, reducing token consumption.
-- Default is TRUE — all agents use the summarised prompt unless explicitly disabled.

-- Add column (no-op if already exists from an earlier run with DEFAULT FALSE)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS compress_system_prompt BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE agents ALTER COLUMN compress_system_prompt SET DEFAULT TRUE;
UPDATE agents SET compress_system_prompt = TRUE WHERE compress_system_prompt = FALSE;

-- Chunked prompt delivery: splits system prompt by ## sections into separate context turns
ALTER TABLE agents ADD COLUMN IF NOT EXISTS chunked_prompt BOOLEAN NOT NULL DEFAULT FALSE;

-- Local refine: rule-based compression, no LLM call — removes filler words only
ALTER TABLE agents ADD COLUMN IF NOT EXISTS local_refine_prompt BOOLEAN NOT NULL DEFAULT FALSE;
