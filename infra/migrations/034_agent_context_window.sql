-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 034: Agent Context Window
-- Limits the number of tool-call turns retained in execMessages during long
-- task executions. Prevents small local models (qwen3:4b, 32k context) from
-- overflowing when tool loops exceed 15-20 iterations.
--
-- Default 8 turns = 8 assistant messages + tool results, keeping total
-- context well within 32k for most system prompts.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_context_pairs INTEGER DEFAULT 8;
