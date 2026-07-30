-- Migration 017: Add report_dir column to agents
-- Allows each agent to have its own reports output directory
-- When set, dashboard HTML reports are saved as .html files in this directory

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS report_dir TEXT;
