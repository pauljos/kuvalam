-- ═══════════════════════════════════════════════════════════════════════════════
-- Agent Tool Scopes — define WHICH tools each agent can use
-- ═══════════════════════════════════════════════════════════════════════════════
-- Without a scope entry, an agent gets NO connector/MCP tools (only built-ins
-- and custom skills).  This is a whitelist-by-default security model.
--
-- scope_type:
--   'connector'   → grants access to a specific tool_connection
--   'mcp_server'  → grants access to a specific MCP server
--   'builtin'     → grant/deny a specific built-in tool by name
--   'group'       → grants all ACTIVE connectors tagged with config->>'group'
--
-- access_level:
--   'allowed'           → tool is visible and usable
--   'denied'            → explicitly blocked (overrides group/archetype grants)
--   'readonly'          → connector is visible but only read-safe methods
--   'requires_approval' → tool requires human confirmation before execution
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_tool_scopes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  scope_type      VARCHAR(50) NOT NULL CHECK (scope_type IN (
    'connector', 'mcp_server', 'builtin', 'group'
  )),

  -- FK to the specific connector or MCP server (nullable for builtin/group)
  connector_id    UUID REFERENCES tool_connections(id) ON DELETE CASCADE,
  mcp_server_id   UUID REFERENCES tool_connections(id) ON DELETE CASCADE,

  -- For 'builtin' scopes: e.g. 'browser_use', 'http_request', 'a2a_call', 'publish_dashboard_report'
  builtin_name    VARCHAR(100),

  -- For 'group' scopes: e.g. 'database', 'communication', 'devops', 'analytics'
  -- Connectors are tagged via tool_connections.config->>'group'
  group_name      VARCHAR(100),

  -- Permission level
  access_level    VARCHAR(20) NOT NULL DEFAULT 'allowed' CHECK (access_level IN (
    'allowed', 'denied', 'readonly', 'requires_approval'
  )),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Ensure at least one identifier is set depending on scope_type
  CONSTRAINT valid_connector_scope CHECK (
    (scope_type = 'connector'  AND connector_id  IS NOT NULL) OR
    (scope_type = 'mcp_server' AND mcp_server_id IS NOT NULL) OR
    (scope_type = 'builtin'    AND builtin_name   IS NOT NULL) OR
    (scope_type = 'group'      AND group_name     IS NOT NULL)
  ),

  -- Prevent duplicate scopes for the same agent+target
  UNIQUE (agent_id, scope_type, connector_id),
  UNIQUE (agent_id, scope_type, mcp_server_id),
  UNIQUE (agent_id, scope_type, builtin_name),
  UNIQUE (agent_id, scope_type, group_name)
);

-- Index for fast lookup at task time
CREATE INDEX IF NOT EXISTS idx_agent_tool_scopes_agent ON agent_tool_scopes(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_tool_scopes_tenant ON agent_tool_scopes(tenant_id);
