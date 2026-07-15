// apps/api/src/services/mcp.service.js
// Model Context Protocol (MCP) Client Service
// Implements client-side JSON-RPC protocol to communicate with SSE/HTTP MCP Servers

import { query } from '../db/pool.js'

/**
 * List all active MCP Server connections for a tenant.
 */
export async function getTenantMcpServers(tenantId) {
  const { rows } = await query(
    `SELECT id, name, config FROM tool_connections 
     WHERE tenant_id = $1 AND tool_id = 'mcp' AND status = 'ACTIVE'`,
    [tenantId]
  )
  return rows
}

/**
 * Call list tools on an MCP Server.
 * Implements standard JSON-RPC 2.0 "tools/list" request.
 */
export async function listMcpTools(mcpServer) {
  const url = mcpServer.config?.url
  if (!url) return []

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(mcpServer.config?.headers || {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'list-tools-request',
        method: 'tools/list',
        params: {}
      })
    })

    if (!response.ok) {
      throw new Error(`MCP Server returned HTTP ${response.status}`)
    }

    const payload = await response.json()
    if (payload.error) {
      throw new Error(`MCP Error: ${payload.error.message || JSON.stringify(payload.error)}`)
    }

    // Return array of tools
    return payload.result?.tools || []
  } catch {
    return []
  }
}

/**
 * Call a tool on an MCP Server.
 * Implements standard JSON-RPC 2.0 "tools/call" request.
 */
export async function callMcpTool(mcpServer, toolName, args) {
  const url = mcpServer.config?.url
  if (!url) {
    return { isError: true, content: [{ type: 'text', text: 'MCP Server not configured with URL' }] }
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(mcpServer.config?.headers || {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `call-tool-${Date.now()}`,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args
        }
      })
    })

    if (!response.ok) {
      throw new Error(`MCP Server returned HTTP ${response.status}`)
    }

    const payload = await response.json()
    if (payload.error) {
      throw new Error(`MCP Error: ${payload.error.message || JSON.stringify(payload.error)}`)
    }

    return payload.result || { isError: false, content: [] }
  } catch {
    return {
      isError: true,
      content: [{ type: 'text', text: `Failed to execute MCP tool: ${err.message}` }]
    }
  }
}
