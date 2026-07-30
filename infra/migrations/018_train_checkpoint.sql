-- Migration 018: Add train_checkpoint column to custom_models
-- Allows training jobs to resume from the last completed step after a crash.
-- Stores JSON: {"phase": "sft"|"dpo"|"merge"|"ollama", "step": N, "timestamp": "..."}

ALTER TABLE custom_models
  ADD COLUMN IF NOT EXISTS train_checkpoint TEXT;
