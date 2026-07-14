// apps/api/src/routes/mcp.routes.js
// HTTP surface for MCP server management (add / list / remove / list-tools).
// MCP servers are stored as rows in `tool_connections` with tool_id = 'mcp'.

import { query } from '../db/pool.js'
import { AppError, errorResponse } from '../utils/errors.js'
import { auditLog } from '../utils/audit.js'
import { getTenantMcpServers, listMcpTools } from '../services/mcp.service.js'
import { encryptCredentials } from '../services/crypto.service.js'

export default async function mcpRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate)

  // GET /tenants/:tenantId/mcp/servers ─ list registered MCP servers (with live tool count)
  fastify.get('/tenants/:tenantId/mcp/servers', async (req, reply) => {
    try {
      const { tenantId } = req.params
      const servers = await getTenantMcpServers(tenantId)

      // Fetch tool counts in parallel (best-effort, don't fail the whole list)
      const enriched = await Promise.all(servers.map(async (s) => {
        let tools = []
        let tool_count = 0
        let status = 'ACTIVE'
        try {
          tools = await listMcpTools(s)
          tool_count = tools.length
        } catch {
          status = 'ERROR'
        }
        return {
          id: s.id,
          name: s.name,
          url: s.config?.url || '',
          status,
          tool_count,
          tools: tools.slice(0, 20).map(t => t.name || t),
        }
      }))

      return reply.send({ success: true, data: { servers: enriched } })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/mcp/servers ─ register a new MCP server
  fastify.post('/tenants/:tenantId/mcp/servers', async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { name, url, authToken } = req.body || {}

      if (!name || !url) {
        throw new AppError('MISSING_FIELDS', 'name and url are required', 400)
      }

      const config = { url }
      if (authToken) {
        config.headers = { Authorization: `Bearer ${authToken}` }
        // Store token separately encrypted so it can be rotated
        config.encrypted_token = encryptCredentials({ token: authToken })
      }

      const { rows: [server] } = await query(
        `INSERT INTO tool_connections (tenant_id, tool_id, name, auth_type, config, status)
         VALUES ($1, 'mcp', $2, $3, $4, 'ACTIVE')
         RETURNING id, name, config, created_at`,
        [tenantId, name, authToken ? 'API_KEY' : 'NONE', config]
      )

      await auditLog({
        eventType: 'mcp.server.added',
        tenantId,
        actorId: req.user.sub,
        actorType: 'USER',
        resourceType: 'ToolConnection',
        resourceId: server.id,
        action: 'ADD_MCP_SERVER',
      })

      return reply.status(201).send({
        success: true,
        data: {
          id: server.id,
          name: server.name,
          url: server.config?.url,
          status: 'ACTIVE',
        },
      })
    } catch (err) { return errorResponse(reply, err) }
  })

  // DELETE /tenants/:tenantId/mcp/servers/:id ─ remove an MCP server
  fastify.delete('/tenants/:tenantId/mcp/servers/:id', async (req, reply) => {
    try {
      const { tenantId, id } = req.params
      const { rowCount } = await query(
        `DELETE FROM tool_connections WHERE id = $1 AND tenant_id = $2 AND tool_id = 'mcp'`,
        [id, tenantId]
      )
      if (rowCount === 0) throw new AppError('NOT_FOUND', 'MCP server not found', 404)

      await auditLog({
        eventType: 'mcp.server.removed',
        tenantId,
        actorId: req.user.sub,
        actorType: 'USER',
        resourceType: 'ToolConnection',
        resourceId: id,
        action: 'REMOVE_MCP_SERVER',
      })

      return reply.send({ success: true, data: { id } })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/mcp/servers/:id/tools ─ live probe for tools
  fastify.get('/tenants/:tenantId/mcp/servers/:id/tools', async (req, reply) => {
    try {
      const { tenantId, id } = req.params
      const { rows: [server] } = await query(
        `SELECT id, name, config FROM tool_connections
         WHERE id = $1 AND tenant_id = $2 AND tool_id = 'mcp'`,
        [id, tenantId]
      )
      if (!server) throw new AppError('NOT_FOUND', 'MCP server not found', 404)

      const tools = await listMcpTools(server)
      return reply.send({ success: true, data: { tools } })
    } catch (err) { return errorResponse(reply, err) }
  })
}
