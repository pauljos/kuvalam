// apps/api/src/services/mcp.service.js
// Model Context Protocol (MCP) Client Service
// Implements client-side JSON-RPC protocol to communicate with SSE/HTTP and stdio MCP Servers

import { spawn } from 'child_process'
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
 * Check if an MCP server uses stdio transport.
 * @param {object} mcpServer - MCP server object from DB
 * @returns {boolean}
 */
function isStdioServer(mcpServer) {
  const cfg = mcpServer.config || {}
  return cfg.transport === 'stdio' || !!cfg.command
}

/**
 * List tools from a stdio-based MCP server.
 * @param {object} config - MCP server config with { command, args, env }
 * @returns {Promise<Array>} List of tool definitions
 */
export async function listMcpToolsStdio(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.command, config.args || [], {
      env: { ...process.env, ...(config.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })

    const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n'
    child.stdin.write(request)
    child.stdin.end()

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('MCP tools/list timed out'))
    }, 15000)

    child.on('close', (code) => {
      clearTimeout(timer)
      if (stderr) console.warn(`[MCP stdio] ${config.command} stderr:`, stderr)
      try {
        const response = JSON.parse(stdout.trim())
        if (response.result?.tools) {
          resolve(response.result.tools)
        } else if (response.error) {
          reject(new Error(`MCP error: ${response.error.message}`))
        } else {
          reject(new Error('Unexpected MCP response format'))
        }
      } catch (err) {
        reject(new Error(`Failed to parse MCP response: ${err.message}. Raw: ${stdout.slice(0, 200)}`))
      }
    })

    child.on('error', reject)
  })
}

/**
 * Call a tool on a stdio-based MCP server.
 * @param {object} config - MCP server config
 * @param {string} toolName - Name of the tool to call
 * @param {object} args - Tool arguments
 * @returns {Promise<object>} Tool result
 */
export async function callMcpToolStdio(config, toolName, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.command, config.args || [], {
      env: { ...process.env, ...(config.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })

    const request = JSON.stringify({
      jsonrpc: '2.0', id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: args || {} }
    }) + '\n'
    child.stdin.write(request)
    child.stdin.end()

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('MCP tools/call timed out'))
    }, 30000)

    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        const response = JSON.parse(stdout.trim())
        if (response.result) {
          resolve(response.result)
        } else if (response.error) {
          reject(new Error(`MCP error: ${response.error.message}`))
        } else {
          reject(new Error('Unexpected MCP response format'))
        }
      } catch (err) {
        reject(new Error(`Failed to parse MCP response: ${err.message}`))
      }
    })

    child.on('error', reject)
  })
}

/**
 * Call list tools on an MCP Server.
 * Implements standard JSON-RPC 2.0 "tools/list" request.
 * Supports both HTTP and stdio transport.
 */
export async function listMcpTools(mcpServer) {
  // Detect stdio-based MCP servers
  if (isStdioServer(mcpServer)) {
    try {
      return await listMcpToolsStdio(mcpServer.config)
    } catch {
      return []
    }
  }

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
 * Supports both HTTP and stdio transport.
 */
export async function callMcpTool(mcpServer, toolName, args) {
  // Detect stdio-based MCP servers
  if (isStdioServer(mcpServer)) {
    try {
      return await callMcpToolStdio(mcpServer.config, toolName, args)
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to execute MCP tool: ${err.message}` }]
      }
    }
  }

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
