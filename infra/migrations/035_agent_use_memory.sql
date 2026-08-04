-- Migration: add use_memory toggle to agents
-- When false (default), agent does NOT include past memory (entity facts or
-- episodic summaries) in the system prompt context.  This gives operators
-- control over whether an agent "remembers" across sessions.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS use_memory BOOLEAN DEFAULT false;
