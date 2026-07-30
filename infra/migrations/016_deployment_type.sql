-- 016_deployment_type.sql
-- Add deployment_type column to tool_connections so integration cards can
-- show a coloured badge indicating where the tool runs:
--   local   – runs on the user's own machine (shell, applescript, local files)
--   cloud   – SaaS/cloud-hosted service (Slack, Jira, GitHub, Gmail, etc.)
--   generic – works both locally and in the cloud (REST APIs, webhooks, DBs)

ALTER TABLE tool_connections
  ADD COLUMN IF NOT EXISTS deployment_type VARCHAR(20) NOT NULL DEFAULT 'cloud';

COMMENT ON COLUMN tool_connections.deployment_type IS
  'Where this connector runs: local, cloud, or generic (both).';

-- Update existing local-shell / local-applescript / local-dir rows if any
UPDATE tool_connections SET deployment_type = 'local'
  WHERE tool_id IN ('local-shell', 'local-applescript', 'local-dir');

-- REST, webhook, database are generic (work anywhere)
UPDATE tool_connections SET deployment_type = 'generic'
  WHERE tool_id IN ('webhook', 'database', 'rest');
