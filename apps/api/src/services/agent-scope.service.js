// ═══════════════════════════════════════════════════════════════════════════════
// Agent Scope Service — manage per-agent tool scopes
// ═══════════════════════════════════════════════════════════════════════════════
// Scope determines WHICH connector, MCP, and built-in tools an agent can use.
// Without any scopes, an agent gets only custom skills + immutable built-ins.
// ═══════════════════════════════════════════════════════════════════════════════

import { query } from '../db/pool.js'
import { AppError } from '../utils/errors.js'

const VALID_SCOPE_TYPES  = ['connector', 'mcp_server', 'builtin', 'group']
const VALID_ACCESS_LEVELS = ['allowed', 'denied', 'readonly', 'requires_approval']

// ─── List scopes for an agent ────────────────────────────────────────────────

export async function listScopes(tenantId, agentId) {
  const { rows } = await query(
    `SELECT s.*,
            c.name AS connector_name, c.tool_id AS connector_tool_id,
            m.name AS mcp_server_name
     FROM agent_tool_scopes s
     LEFT JOIN tool_connections c ON c.id = s.connector_id
     LEFT JOIN tool_connections m ON m.id = s.mcp_server_id
     WHERE s.tenant_id = $1 AND s.agent_id = $2
     ORDER BY s.scope_type, s.created_at`,
    [tenantId, agentId]
  )
  return rows
}

// ─── Add a scope ─────────────────────────────────────────────────────────────

export async function addScope(tenantId, agentId, data) {
  const { scopeType, connectorId, mcpServerId, builtinName, groupName, accessLevel } = data

  if (!scopeType || !VALID_SCOPE_TYPES.includes(scopeType)) {
    throw new AppError('INVALID_SCOPE_TYPE', `scopeType must be one of: ${VALID_SCOPE_TYPES.join(', ')}`, 400)
  }

  // Validate that the referenced connector exists and belongs to the tenant
  if (connectorId) {
    const { rows: [conn] } = await query(
      'SELECT id FROM tool_connections WHERE id = $1 AND tenant_id = $2',
      [connectorId, tenantId]
    )
    if (!conn) throw new AppError('CONNECTOR_NOT_FOUND', 'Connector not found for this tenant', 404)
  }
  if (mcpServerId) {
    const { rows: [mcp] } = await query(
      'SELECT id FROM tool_connections WHERE id = $1 AND tenant_id = $2 AND tool_id = $3',
      [mcpServerId, tenantId, 'mcp']
    )
    if (!mcp) throw new AppError('MCP_SERVER_NOT_FOUND', 'MCP server not found for this tenant', 404)
  }

  // Validate accessLevel
  const level = accessLevel || 'allowed'
  if (!VALID_ACCESS_LEVELS.includes(level)) {
    throw new AppError('INVALID_ACCESS_LEVEL', `accessLevel must be one of: ${VALID_ACCESS_LEVELS.join(', ')}`, 400)
  }

  const { rows: [scope] } = await query(
    `INSERT INTO agent_tool_scopes
       (agent_id, tenant_id, scope_type, connector_id, mcp_server_id, builtin_name, group_name, access_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [agentId, tenantId, scopeType, connectorId || null, mcpServerId || null, builtinName || null, groupName || null, level]
  )
  return scope
}

// ─── Update a scope's access level ───────────────────────────────────────────

export async function updateScope(tenantId, agentId, scopeId, data) {
  const level = data.accessLevel
  if (!level || !VALID_ACCESS_LEVELS.includes(level)) {
    throw new AppError('INVALID_ACCESS_LEVEL', `accessLevel must be one of: ${VALID_ACCESS_LEVELS.join(', ')}`, 400)
  }

  const { rows: [scope] } = await query(
    `UPDATE agent_tool_scopes
     SET access_level = $1
     WHERE id = $2 AND agent_id = $3 AND tenant_id = $4
     RETURNING *`,
    [level, scopeId, agentId, tenantId]
  )
  if (!scope) throw new AppError('SCOPE_NOT_FOUND', 'Scope not found', 404)
  return scope
}

// ─── Remove a scope ──────────────────────────────────────────────────────────

export async function removeScope(tenantId, agentId, scopeId) {
  const { rowCount } = await query(
    'DELETE FROM agent_tool_scopes WHERE id = $1 AND agent_id = $2 AND tenant_id = $3',
    [scopeId, agentId, tenantId]
  )
  if (rowCount === 0) throw new AppError('SCOPE_NOT_FOUND', 'Scope not found', 404)
  return true
}

// ─── Bulk set scopes for an agent (replace all) ──────────────────────────────

export async function setScopes(tenantId, agentId, scopes) {
  // scopes is an array of scope objects like addScope accepts
  const client = await query('BEGIN')
  try {
    // Remove existing scopes
    await query('DELETE FROM agent_tool_scopes WHERE agent_id = $1 AND tenant_id = $2', [agentId, tenantId])

    // Insert new scopes
    for (const s of scopes) {
      await addScope(tenantId, agentId, s)
    }

    await query('COMMIT')
    return await listScopes(tenantId, agentId)
  } catch (err) {
    await query('ROLLBACK')
    throw err
  }
}

// ─── Resolve effective tool scopes for an agent (used by task.service.js) ────

export async function resolveAgentScopes(tenantId, agentId) {
  const scopes = await listScopes(tenantId, agentId)

  const result = {
    // Sets of allowed connector IDs, MCP server IDs, built-in names, groups
    allowedConnectors: new Set(),
    allowedMcpServers: new Set(),
    allowedBuiltins: new Set(),
    allowedGroups: new Set(),

    // Denied overrides
    deniedConnectors: new Set(),
    deniedMcpServers: new Set(),
    deniedBuiltins: new Set(),
    deniedGroups: new Set(),

    // Readonly connectors
    readonlyConnectors: new Set(),

    // Requires approval
    approvalConnectors: new Set(),
    approvalMcpServers: new Set(),
    approvalBuiltins: new Set(),

    // ── Tool-name–level matching helpers ─────────────────────────────────
    // executeTool receives only a tool name (e.g. "slack__post_message",
    // "mcp__abc_123__tool"), not connector UUIDs. These sets allow O(1)
    // matching of tool names to approval scopes.
    approvalConnectorProviders: new Set(),     // e.g. "slack", "jira", "github"
    approvalMcpServerIdsUnderscored: new Set(), // e.g. "abc_123" (hyphens → underscores)
  }

  for (const s of scopes) {
    const level = s.access_level

    if (s.scope_type === 'connector' && s.connector_id) {
      if (level === 'denied')            result.deniedConnectors.add(s.connector_id)
      else if (level === 'readonly')     result.readonlyConnectors.add(s.connector_id)
      else if (level === 'requires_approval') {
        result.approvalConnectors.add(s.connector_id)
        // Store provider prefix for tool-name matching in executeTool
        if (s.connector_tool_id) {
          result.approvalConnectorProviders.add(s.connector_tool_id.toLowerCase())
        }
      }
      else                               result.allowedConnectors.add(s.connector_id)
    }

    if (s.scope_type === 'mcp_server' && s.mcp_server_id) {
      if (level === 'denied')            result.deniedMcpServers.add(s.mcp_server_id)
      else if (level === 'requires_approval') {
        result.approvalMcpServers.add(s.mcp_server_id)
        // Store underscored version for matching against tool names
        // (tool names use mcp__<uuid_with_underscores>__<tool>)
        result.approvalMcpServerIdsUnderscored.add(s.mcp_server_id.replace(/-/g, '_'))
      }
      else                               result.allowedMcpServers.add(s.mcp_server_id)
    }

    if (s.scope_type === 'builtin' && s.builtin_name) {
      if (level === 'denied')            result.deniedBuiltins.add(s.builtin_name)
      else if (level === 'requires_approval') result.approvalBuiltins.add(s.builtin_name)
      else                               result.allowedBuiltins.add(s.builtin_name)
    }

    if (s.scope_type === 'group' && s.group_name) {
      if (level === 'denied')            result.deniedGroups.add(s.group_name)
      else                               result.allowedGroups.add(s.group_name)
    }
  }

  // ── Tenant-level built-in tool overrides ──────────────────────────────────
  // tool_connections rows with tool_id='builtin' and status='INACTIVE'
  // act as tenant-wide defaults. Agent-level scopes take precedence:
  // if an agent has an explicit 'allowed' scope for a tool, the tenant-level
  // disable is ignored for that agent.
  try {
    const { rows: tenantOverrides } = await query(
      `SELECT name, status FROM tool_connections
       WHERE tenant_id = $1 AND tool_id = 'builtin'`,
      [tenantId]
    )
    for (const override of tenantOverrides) {
      if (override.status === 'INACTIVE' && !result.allowedBuiltins.has(override.name)) {
        // Only deny if agent doesn't have an explicit override allowing it
        result.deniedBuiltins.add(override.name)
      }
    }
  } catch (err) {
    // Non-critical: table may not exist yet or query may fail
    console.warn(`[scopes] Failed to load tenant-level tool overrides: ${err.message}`)
  }

  return result
}

// ─── Archetype → scope presets ───────────────────────────────────────────────

// These presets auto-generate scope suggestions when creating an agent
// with a matching archetype. The UI can present these for the user to accept.
//
// ARCHETYPE NAME ALIASES — the UI and builder use simple names (research,
// analytics, coordinator) while older agents may use kebab-case or UPPERCASE.
// This map normalizes everything before lookup so ALL agents get presets.
const ARCHETYPE_ALIASES = {
  // UI template names → preset keys
  'analytics':          'data-analyst',
  'research':           'research',
  'communication':      'customer-support',
  'support':            'customer-support',
  'customer-support':   'customer-support',
  'coordinator':        'coordinator',
  'planner':            'planner',
  'compliance':         'compliance',
  'document':           'document',
  'developer':          'developer',
  'agent-generation':   'agent-generation',
  'agent_generation':   'agent-generation',
  'orchestrator':       'agent-generation',
  'meta-agent':         'agent-generation',
  // UPPERCASE variants (legacy seed data)
  'ANALYST':            'analyst',
  'SUPPORT':            'customer-support',
  'LEGAL':              'compliance',
  'FINANCE':            'compliance',
  'COORDINATOR':        'coordinator',
  'PLANNER':            'planner',
  // New archetypes
  'engineering':         'engineering',
  'iot':                 'iot',
  'scientific':          'scientific',
  'medical':             'medical',
  'generalist':          'generalist',
  'none':                'generalist',  // 'none' gets generalist scopes
  'news-media':          'news-media',
  'news':                'news-media',
  'media':               'news-media',
  'journalist':          'news-media',
  'journalism':          'news-media',
  'insurance':           'insurance',
  'banking':             'banking',
  'bank':                'banking',
  'finance':             'banking',
  'financial':           'banking',
  'fintech':             'banking',  // Tenant Supervisor — the "god" agent (G7). One per tenant.
  'tenant-supervisor':  'tenant-supervisor',
  'tenant_supervisor':  'tenant-supervisor',
  'supervisor':         'tenant-supervisor',  // Scope preset names (direct passthrough)
  'data-analyst':       'data-analyst',
  'analyst':            'analyst',
  'browser-automation': 'browser-automation',
}

export function getArchetypeScopePresets(archetype) {
  // Normalize through alias map (case-insensitive fallback)
  const key = ARCHETYPE_ALIASES[archetype]
    || ARCHETYPE_ALIASES[archetype?.toLowerCase()]
    || null
  if (!key) return null

  const presets = {
    // ── Customer Support Agent ────────────────────────────────────────────
    'customer-support': [
      { scopeType: 'group',     groupName: 'communication',         accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'slack',         accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'jira',          accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'gmail',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
    ],

    // ── Data Analyst ─────────────────────────────────────────────────────
    // Weapons: Database (SQL queries), knowledge-graph (entity relationships),
    //          Slack (share insights), Gmail (reports),
    //          browser (data research), dashboard (visualisations),
    //          http_download (download datasets), file_search (search data files),
    //          docker_run (run analysis containers)
    'data-analyst': [
      { scopeType: 'group',     groupName: 'database',               accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'knowledge-graph', accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'slack',         accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'gmail',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'file_search',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'docker_run',            accessLevel: 'requires_approval' },
    ],

    // ── Developer ────────────────────────────────────────────────────────
    // Weapons: GitHub (code), Jira (issues), Linear (tasks), Slack (team),
    //          browser (docs), HTTP (API calls), delegation,
    //          http_download (deps), file_search (code/logs),
    //          docker_run (dev containers, CI), ssh_exec (deployments)
    'developer': [
      { scopeType: 'group',     groupName: 'development',            accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'github',         accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'jira',           accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'linear',         accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'slack',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'file_search',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'docker_run',            accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'ssh_exec',             accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'delegate_task',        accessLevel: 'allowed' },
    ],

    // ── Browser Automation ───────────────────────────────────────────────
    // Weapons: browser (core), HTTP (API interactions), webhook (pipelines),
    //          Slack (notifications), dashboard (reports),
    //          http_download (save files from browsed pages)
    'browser-automation': [
      { scopeType: 'connectorType', connectorType: 'slack',          accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'webhook',        accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
    ],

    // ── Analyst (Read-Only) ──────────────────────────────────────────────
    'analyst': [
      { scopeType: 'group',     groupName: 'database',               accessLevel: 'readonly' },
      { scopeType: 'connectorType', connectorType: 'gmail',         accessLevel: 'readonly' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'requires_approval' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'requires_approval' },
      { scopeType: 'builtin',  builtinName: 'file_search',           accessLevel: 'readonly' },
      { scopeType: 'builtin',  builtinName: 'docker_run',            accessLevel: 'denied' },
      { scopeType: 'builtin',  builtinName: 'ssh_exec',             accessLevel: 'denied' },
    ],

    // ── Research Agent ───────────────────────────────────────────────────
    // Weapons: browser (web research), HTTP (APIs), file_search (docs),
    //          http_download (PDFs, datasets), dashboard (reports),
    //          A2A (delegate sub-research). NO database by default.
    'research': [
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'file_search',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
    ],

    // ── Coordinator / Workflow Orchestrator ──────────────────────────────
    // Weapons: Everything needed to build and run multi-agent pipelines.
    'coordinator': [
      { scopeType: 'group',     groupName: 'communication',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'delegate_task',        accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'create_agent',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'create_workflow',      accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'create_trigger',       accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'create_connector',     accessLevel: 'requires_approval' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
    ],

    // ── Planner / Project Manager ────────────────────────────────────────
    'planner': [
      { scopeType: 'group',     groupName: 'communication',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'delegate_task',        accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'create_agent',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'create_workflow',      accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'create_trigger',       accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
    ],

    // ── Compliance / Legal / Finance ─────────────────────────────────────
    'compliance': [
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'file_search',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'delegate_task',        accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
    ],

    // ── Document / Content ───────────────────────────────────────────────
    'document': [
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'file_search',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
    ],

    // ── Agent Generation / Meta-Orchestrator ─────────────────────────────
    // Purpose: create and manage other agents, workflows, triggers, and
    // connectors on-the-fly. This is the archetype for agents that "oversee"
    // humans and spin up specialist sub-agents autonomously.
    'agent-generation': [
      { scopeType: 'builtin',  builtinName: 'create_agent',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'create_workflow',       accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'create_trigger',        accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'create_connector',      accessLevel: 'requires_approval' },
      { scopeType: 'builtin',  builtinName: 'delegate_task',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',              accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
      { scopeType: 'group',    groupName: 'communication',           accessLevel: 'allowed' },
    ],

    // ── Tenant Supervisor — the "god" agent (G7) ─────────────────────────
    // One per tenant. Watches the fleet, cancels runaway tasks, opens circuit
    // breakers, and can raise supervisor-initiated HITL approvals. Autonomy
    // is intentionally AUTONOMOUS — it must not itself need human approval.
    // Should be created only by platform admin; see agent.service.js.
    'tenant-supervisor': [
      { scopeType: 'builtin',  builtinName: 'cancel_task',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'pause_task',            accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'delegate_task',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',              accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_tenant_memory',   accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'read_tenant_memory',    accessLevel: 'allowed' },
      { scopeType: 'group',    groupName: 'communication',           accessLevel: 'allowed' },
    ],

    // ── Engineering (Civil / Structural / Mechanical) ────────────────────
    'engineering': [
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'file_search',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
      { scopeType: 'group',    groupName: 'database',               accessLevel: 'readonly' },
    ],

    // ── IoT / Embedded ──────────────────────────────────────────────────
    'iot': [
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'file_search',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
      { scopeType: 'group',    groupName: 'database',               accessLevel: 'readonly' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
    ],

    // ── Scientific (Physics / Chemistry / Biology / Math) ────────────────
    'scientific': [
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'file_search',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
      { scopeType: 'group',    groupName: 'database',               accessLevel: 'readonly' },
    ],

    // ── Medical / Healthcare ────────────────────────────────────────────
    'medical': [
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'file_search',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
    ],

    // ── Generalist ──────────────────────────────────────────────────────
    'generalist': [
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'file_search',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
      { scopeType: 'group',    groupName: 'database',               accessLevel: 'readonly' },
    ],

    // ── News & Media ───────────────────────────────────────────────────
    // Weapons: browser (news sites), HTTP (RSS/news APIs), file_search,
    //          http_download (articles/PDFs), dashboard (media reports),
    //          write_artifact (articles, newsletters, press releases),
    //          Slack/Gmail (distribution), A2A (delegate research)
    'news-media': [
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'file_search',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'slack',         accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'gmail',         accessLevel: 'allowed' },
    ],

    // ── Insurance ──────────────────────────────────────────────────────
    // Weapons: database (policies/claims), file_search (documents),
    //          browser (portals), HTTP (regulatory/benchmarks),
    //          http_download (forms/statements), dashboard (reports),
    //          write_artifact (assessments), Gmail/Slack (comms)
    'insurance': [
      { scopeType: 'group',    groupName: 'database',               accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'file_search',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'gmail',         accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'slack',         accessLevel: 'allowed' },
    ],

    // ── Banking / Financial Services ────────────────────────────────────
    // Weapons: database (transactions/accounts), file_search (statements),
    //          browser (portals/regulatory), HTTP (market data/SWIFT),
    //          http_download (filings), dashboard (metrics),
    //          write_artifact (reports/audit trails)
    'banking': [
      { scopeType: 'group',    groupName: 'database',               accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'browser_use',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_request',          accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'http_download',         accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'file_search',           accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'write_artifact',        accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'publish_dashboard_report', accessLevel: 'allowed' },
      { scopeType: 'builtin',  builtinName: 'a2a_call',             accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'gmail',         accessLevel: 'allowed' },
      { scopeType: 'connectorType', connectorType: 'slack',         accessLevel: 'allowed' },
    ],
  }
  return presets[key] || null
}
