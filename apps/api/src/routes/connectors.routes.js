// apps/api/src/routes/connectors.routes.js
import { query } from '../db/pool.js'
import { AppError } from '../utils/errors.js'
import { auditLog } from '../utils/audit.js'
import { encryptCredentials, decryptCredentials } from '../services/crypto.service.js'
import { getAuthorizationUrl } from '../services/oauth.service.js'
import { verifyConnector } from '../services/connector-tools.service.js'
import { requirePermission } from '../middleware/rbac.js'

const ts = () => ({ requestId: undefined, timestamp: new Date().toISOString() })

export default async function connectorsRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate)

  // List connectors for tenant (config decrypted for UI display)
  fastify.get('/tenants/:tenantId/connectors', async (req, reply) => {
    const { tenantId } = req.params
    const { rows } = await query(
      `SELECT id, tenant_id, tool_id, name, auth_type, status, config, deployment_type, last_tested_at, last_error, created_at, updated_at
       FROM tool_connections WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    )
    // Decrypt config for safe UI display (host, path, baseUrl, etc.)
    const connectors = rows.map(r => ({
      ...r,
      config: decryptCredentials(r.config || {})
    }))
    return { success: true, data: { connectors }, meta: ts() }
  })

  // List available connector tool definitions for the workflow builder palette.
  // Returns every tool name, description, args schema, and the parent connector
  // so the UI can show a rich autocomplete for TOOL / agent-scope steps.
  fastify.get('/tenants/:tenantId/connectors/tool-definitions', async (req, reply) => {
    const { tenantId } = req.params
    const { getConnectorToolDefinitions } = await import('../services/connector-tools.service.js')
    const defs = await getConnectorToolDefinitions(tenantId)
    return { success: true, data: { tools: defs }, meta: ts() }
  })

  // Initiate OAuth flow — returns a redirect URL to the provider
  fastify.post('/tenants/:tenantId/connectors/oauth/initiate', {
    preHandler: [requirePermission('connector:create')]
  }, async (req, reply) => {
    const { tenantId } = req.params
    const { provider, service, connectorId } = req.body || {}

    if (!provider) {
      throw new AppError('MISSING_PROVIDER', 'provider is required', 400)
    }

    try {
      // Validate credentials and return the authorization URL directly.
      // This prevents stale PENDING rows from accumulating in the database.
      const finalUrl = await getAuthorizationUrl({ provider, service, tenantId, connectorId: connectorId || 'new' })
      return { success: true, data: { authorizationUrl: finalUrl, connectorId: connectorId || 'new' }, meta: ts() }
    } catch (err) {
      // If the tenant hasn't registered an OAuth app yet, tell the UI which
      // provider needs credentials so it can render the "paste Client ID /
      // Secret" form instead of just a generic error message.
      if (err.code === 'OAUTH_APP_NOT_CONFIGURED') {
        throw new AppError(
          'OAUTH_APP_NOT_CONFIGURED',
          err.message,
          409,
          { provider: err.provider, redirectUri: err.redirectUri }
        )
      }
      // Surface the underlying reason so the UI can render something useful.
      // Unknown-provider / missing-client-id / signing failures otherwise become
      // a generic 500 "Internal server error" and users can't diagnose them.
      throw new AppError('OAUTH_INITIATE_FAILED', err.message || 'OAuth initiation failed', 400)
    }
  })

  // Create a connector (credentials encrypted at rest)
  fastify.post('/tenants/:tenantId/connectors', {
    preHandler: [requirePermission('connector:create')]
  }, async (req, reply) => {
    const { tenantId } = req.params
    const { toolId, name, authType, config, deploymentType } = req.body

    if (!toolId || !name) {
      throw new AppError('MISSING_FIELDS', 'toolId and name are required', 400)
    }

    // ── M6: Enforce connector plan limits ──────────────────────────────────
    const { rows: [{ count: connectorCount }] } = await query(
      `SELECT COUNT(*) as count FROM tool_connections WHERE tenant_id = $1`,
      [tenantId]
    )
    const { checkPlanLimit } = await import('../services/plan-limits.service.js')
    await checkPlanLimit(tenantId, 'connectors', parseInt(connectorCount || 0))

    // Validate deployment_type if provided
    const validDeploymentTypes = ['local', 'cloud', 'generic']
    const deployType = validDeploymentTypes.includes(deploymentType) ? deploymentType : 'cloud'

    // Encrypt sensitive fields before storing
    const encryptedConfig = encryptCredentials(config || {})

    // NEW: start in PENDING. A successful Test transitions to ACTIVE.
    // Prevents unconfigured connectors from appearing "connected" in the UI
    // and being auto-registered as agent tools.
    const { rows: [conn] } = await query(
      `INSERT INTO tool_connections (tenant_id, tool_id, name, auth_type, config, deployment_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING') RETURNING id, tenant_id, tool_id, name, auth_type, deployment_type, status, created_at`,
      [tenantId, toolId, name, authType || 'API_KEY', encryptedConfig, deployType]
    )

    await auditLog({
      tenantId, eventType: 'connector.created', actorId: req.user.id, actorType: 'USER',
      resourceType: 'ToolConnection', resourceId: conn.id, action: 'CREATE_CONNECTOR'
    })

    return reply.status(201).send({ data: conn })
  })


  // Update a connector (name + config, re-encrypts credentials)
  fastify.put('/tenants/:tenantId/connectors/:connectorId', {
    preHandler: [requirePermission('connector:update')]
  }, async (req, reply) => {
    const { tenantId, connectorId } = req.params
    const { name, config, deploymentType } = req.body || {}

    const { rows: [existing] } = await query(
      `SELECT * FROM tool_connections WHERE id = $1 AND tenant_id = $2`,
      [connectorId, tenantId]
    )
    if (!existing) throw new AppError('CONNECTOR_NOT_FOUND', 'Connector not found', 404)

    if (!name) throw new AppError('MISSING_FIELDS', 'name is required', 400)

    // Merge existing config with new values, re-encrypt
    const mergedConfig = { ...(existing.config || {}), ...(config || {}) }
    const encryptedConfig = encryptCredentials(mergedConfig)

    // Build SET clause dynamically to include deployment_type if provided
    const validDeploymentTypes = ['local', 'cloud', 'generic']
    const deployType = validDeploymentTypes.includes(deploymentType) ? deploymentType : undefined
    const setClauses = [`name = $1`, `config = $2`, `status = 'PENDING'`, `updated_at = NOW()`]
    const params = [name, encryptedConfig]
    if (deployType) {
      setClauses.push(`deployment_type = $${params.length + 1}`)
      params.push(deployType)
    }
    params.push(connectorId)

    // Reset to PENDING on update — forces a re-test to re-activate
    await query(
      `UPDATE tool_connections SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
      params
    )

    const { rows: [updated] } = await query(
      `SELECT id, tenant_id, tool_id, name, auth_type, status, config, deployment_type, created_at, updated_at
       FROM tool_connections WHERE id = $1`,
      [connectorId]
    )

    // Decrypt config before returning
    updated.config = decryptCredentials(updated.config || {})

    await auditLog({
      tenantId, eventType: 'connector.updated', actorId: req.user.id, actorType: 'USER',
      resourceType: 'ToolConnection', resourceId: connectorId, action: 'UPDATE_CONNECTOR'
    })

    return { success: true, data: updated, meta: ts() }
  })

  // Test a connector (real credential verification, per-provider ping)
  fastify.post('/tenants/:tenantId/connectors/:connectorId/test', {
    preHandler: [requirePermission('connector:update')]
  }, async (req, reply) => {
    const { tenantId, connectorId } = req.params

    const { rows: [conn] } = await query(
      `SELECT * FROM tool_connections WHERE id = $1 AND tenant_id = $2`,
      [connectorId, tenantId]
    )
    if (!conn) throw new AppError('CONNECTOR_NOT_FOUND', 'Connector not found', 404)

    let testResult
    if (conn.tool_id === 'mcp') {
      // Existing MCP-specific verification path (list tools)
      try {
        const { listMcpTools } = await import('../services/mcp.service.js')
        const tools = await listMcpTools(conn)
        if (tools.length > 0) {
          testResult = { success: true, message: `Connected: found ${tools.length} MCP tools (${tools.slice(0, 5).map(t => t.name).join(', ')}${tools.length > 5 ? '…' : ''})` }
        } else {
          testResult = { success: false, message: 'MCP server responded but returned 0 tools' }
        }
      } catch (err) {
        testResult = { success: false, message: err.message }
      }
    } else {
      // All other providers → verifyConnector (checks OAuth token / API_KEY fields + provider ping)
      testResult = await verifyConnector(conn)
    }

    // Only move to ACTIVE on a real success. Otherwise record the reason for the failure.
    await query(
      `UPDATE tool_connections
         SET last_tested_at = NOW(),
             status = $1,
             last_error = $2
         WHERE id = $3`,
      [testResult.success ? 'ACTIVE' : 'ERROR', testResult.success ? null : testResult.message, connectorId]
    )

    await auditLog({
      tenantId, eventType: 'connector.tested', actorId: req.user.id, actorType: 'USER',
      resourceType: 'ToolConnection', resourceId: connectorId, action: 'TEST_CONNECTOR',
      afterState: { success: testResult.success }
    })

    return { success: true, data: testResult, meta: ts() }
  })

  // Delete a connector
  fastify.delete('/tenants/:tenantId/connectors/:connectorId', {
    preHandler: [requirePermission('connector:delete')]
  }, async (req, reply) => {
    const { tenantId, connectorId } = req.params

    const { rows: [conn] } = await query(
      `DELETE FROM tool_connections WHERE id = $1 AND tenant_id = $2 RETURNING id, name`,
      [connectorId, tenantId]
    )
    if (!conn) throw new AppError('CONNECTOR_NOT_FOUND', 'Connector not found', 404)

    await auditLog({
      tenantId, eventType: 'connector.deleted', actorId: req.user.id, actorType: 'USER',
      resourceType: 'ToolConnection', resourceId: connectorId, action: 'DELETE_CONNECTOR'
    })

    return { success: true, data: { deleted: true, id: connectorId }, meta: ts() }
  })

  // Toggle a tool_connection status between ACTIVE ↔ INACTIVE
  // Works for connectors, MCP servers, and built-in tool overrides.
  fastify.put('/tenants/:tenantId/connectors/:connectorId/toggle', {
    preHandler: [requirePermission('connector:update')]
  }, async (req, reply) => {
    const { tenantId, connectorId } = req.params

    const { rows: [conn] } = await query(
      `SELECT * FROM tool_connections WHERE id = $1 AND tenant_id = $2`,
      [connectorId, tenantId]
    )
    if (!conn) throw new AppError('CONNECTOR_NOT_FOUND', 'Connector not found', 404)

    const newStatus = conn.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
    await query(
      `UPDATE tool_connections SET status = $1, updated_at = NOW() WHERE id = $2`,
      [newStatus, connectorId]
    )

    await auditLog({
      tenantId, eventType: 'connector.toggled', actorId: req.user.id, actorType: 'USER',
      resourceType: 'ToolConnection', resourceId: connectorId, action: 'TOGGLE_CONNECTOR',
      afterState: { status: newStatus }
    })

    return { success: true, data: { id: connectorId, status: newStatus }, meta: ts() }
  })

  // ── Built-in Tool Overrides ─────────────────────────────────────────────
  // Built-in tools are enabled by default. Creating a row in tool_connections
  // with tool_id='builtin' and status='INACTIVE' disables that tool for the tenant.
  // Deleting the row re-enables it.

  // List built-in tool overrides (which built-in tools are disabled)
  fastify.get('/tenants/:tenantId/tools/overrides', async (req, reply) => {
    const { tenantId } = req.params
    const { rows } = await query(
      `SELECT id, name as tool_name, status FROM tool_connections
       WHERE tenant_id = $1 AND tool_id = 'builtin'`,
      [tenantId]
    )
    return { success: true, data: { overrides: rows }, meta: ts() }
  })

  // Toggle a built-in tool on/off for this tenant
  fastify.put('/tenants/:tenantId/tools/:toolName/toggle', {
    preHandler: [requirePermission('connector:update')]
  }, async (req, reply) => {
    const { tenantId, toolName } = req.params

    // See if an override row already exists
    const { rows: existing } = await query(
      `SELECT id, status FROM tool_connections
       WHERE tenant_id = $1 AND tool_id = 'builtin' AND name = $2`,
      [tenantId, toolName]
    )

    if (existing.length > 0) {
      const row = existing[0]
      const newStatus = row.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
      await query(
        `UPDATE tool_connections SET status = $1, updated_at = NOW() WHERE id = $2`,
        [newStatus, row.id]
      )
      return { success: true, data: { toolName, status: newStatus, id: row.id }, meta: ts() }
    }

    // No override yet — create one (tool is currently enabled, so we're disabling it)
    const { rows: [created] } = await query(
      `INSERT INTO tool_connections (tenant_id, tool_id, name, auth_type, config, status)
       VALUES ($1, 'builtin', $2, 'NONE', '{}', 'INACTIVE')
       RETURNING id, name, status`,
      [tenantId, toolName]
    )

    await auditLog({
      tenantId, eventType: 'tool.toggled', actorId: req.user.id, actorType: 'USER',
      resourceType: 'ToolConnection', resourceId: created.id, action: 'TOGGLE_BUILTIN_TOOL',
      afterState: { toolName, status: 'INACTIVE' }
    })

    return { success: true, data: { toolName, status: 'INACTIVE', id: created.id }, meta: ts() }
  })
}

