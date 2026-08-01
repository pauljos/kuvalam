-- Migration 030: default prompt delivery = local refine + non-chunked
--
-- Previously (029) the default was compress_system_prompt = TRUE (⚡ AI
-- compressed). Product decision: new agents should ship as "✂️ Local trimmed"
-- (rule-based, no LLM call) with single (non-chunked) delivery.
--
-- This migration:
--   1. Flips the column DEFAULTS so future INSERTs inherit the new behaviour.
--   2. Updates ALL existing agents to the new default (local refine ON,
--      AI compression OFF, chunked OFF) so behaviour is consistent.

-- ── 1. Column defaults for newly created agents ─────────────────────────────
ALTER TABLE agents ALTER COLUMN compress_system_prompt SET DEFAULT FALSE;
ALTER TABLE agents ALTER COLUMN local_refine_prompt SET DEFAULT TRUE;
ALTER TABLE agents ALTER COLUMN chunked_prompt SET DEFAULT FALSE;

-- ── 2. Existing agents → local refine + non-chunked ─────────────────────────
UPDATE agents
   SET compress_system_prompt = FALSE,
       local_refine_prompt    = TRUE,
       chunked_prompt         = FALSE;
