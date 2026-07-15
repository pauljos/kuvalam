// apps/api/src/routes/connectors.routes.js
import { query } from '../db/pool.js'
import { AppError } from '../utils/errors.js'
import { auditLog } from '../utils/audit.js'
import { encryptCredentials } from '../services/crypto.service.js'
import { getAuthorizationUrl } from '../services/oauth.service.js'
import { verifyConnector } from '../services/connector-tools.service.js'

export default async function connectorsRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate)

  // List connectors for tenant (config field intentionally excluded from list)
  fastify.get('/tenants/:tenantId/connectors', async (req, reply) => {
    const { tenantId } = req.params
    const { rows } = await query(
      `SELECT id, tenant_id, tool_id, name, auth_type, status, last_tested_at, last_error, created_at, updated_at
       FROM tool_connections WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    )
    return { data: { connectors: rows } }
  })

  // Initiate OAuth flow — returns a redirect URL to the provider
  fastify.post('/tenants/:tenantId/connectors/oauth/initiate', async (req, reply) => {
    const { tenantId } = req.params
    const { provider, service, connectorId } = req.body || {}

    if (!provider) {
      throw new AppError('MISSING_PROVIDER', 'provider is required', 400)
    }

    try {
      // Validate credentials BEFORE creating a connector row.
      // This prevents stale PENDING rows from accumulating every time the user
      // clicks "Authorise" without having registered an OAuth app for the tenant.
      const url = await getAuthorizationUrl({ provider, service, tenantId, connectorId: connectorId || 'preflight' })

      // Credentials exist and URL is valid — now upsert the connector row.
      let id = connectorId
      if (!id) {
        // Delete any pre-existing PENDING connector for this provider so we
        // don't accumulate orphan rows if the user retries.
        await query(
          `DELETE FROM tool_connections WHERE tenant_id = $1 AND tool_id = $2 AND status = 'PENDING' AND auth_type = 'OAUTH2'`,
          [tenantId, provider]
        )
        const { rows: [conn] } = await query(
          `INSERT INTO tool_connections (tenant_id, tool_id, name, auth_type, config, status)
           VALUES ($1, $2, $3, 'OAUTH2', '{}', 'PENDING') RETURNING id`,
          [tenantId, provider, `${provider} (OAuth)`]
        )
        id = conn.id
      }

      // Re-sign the state with the real connectorId now that we have it
      const finalUrl = await getAuthorizationUrl({ provider, service, tenantId, connectorId: id })
      return { data: { authorizationUrl: finalUrl, connectorId: id } }
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
  fastify.post('/tenants/:tenantId/connectors', async (req, reply) => {
    const { tenantId } = req.params
    const { toolId, name, authType, config } = req.body

    if (!toolId || !name) {
      throw new AppError('MISSING_FIELDS', 'toolId and name are required', 400)
    }

    // Encrypt sensitive fields before storing
    const encryptedConfig = encryptCredentials(config || {})

    // NEW: start in PENDING. A successful Test transitions to ACTIVE.
    // Prevents unconfigured connectors from appearing "connected" in the UI
    // and being auto-registered as agent tools.
    const { rows: [conn] } = await query(
      `INSERT INTO tool_connections (tenant_id, tool_id, name, auth_type, config, status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING') RETURNING id, tenant_id, tool_id, name, auth_type, status, created_at`,
      [tenantId, toolId, name, authType || 'API_KEY', encryptedConfig]
    )

    await auditLog({
      tenantId, eventType: 'connector.created', actorId: req.user.id, actorType: 'USER',
      resourceType: 'ToolConnection', resourceId: conn.id, action: 'CREATE_CONNECTOR'
    })

    return reply.status(201).send({ data: conn })
  })

  // Test a connector (real credential verification, per-provider ping)
  fastify.post('/tenants/:tenantId/connectors/:connectorId/test', async (req, reply) => {
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

    return { data: testResult }
  })

  // Delete a connector
  fastify.delete('/tenants/:tenantId/connectors/:connectorId', async (req, reply) => {
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

    return { data: { deleted: true, id: connectorId } }
  })
}

