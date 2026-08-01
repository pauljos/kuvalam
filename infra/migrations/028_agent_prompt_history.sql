-- Migration 028: Add system_prompt_history to agents
-- Keeps a bounded stack of previous system_prompt values so a refine/edit can
-- be undone. Newest version is appended last; the undo endpoint pops it.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS system_prompt_history JSONB NOT NULL DEFAULT '[]'::jsonb;
