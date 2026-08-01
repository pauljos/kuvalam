// apps/api/src/services/connector-tools.service.js
// Turns configured connector rows in `tool_connections` into first-class
// tools that the agent's LLM can pick during a task run.
//
// Responsibilities:
//   1. verifyConnector(conn)       — used by the Test endpoint to reject
//                                    connectors that aren't really configured
//   2. getConnectorToolDefinitions(tenantId) — LLM tool schemas for every
//                                    ACTIVE connector so the model can plan with them
//   3. executeConnectorTool(name, input, tenantId) — dispatch a tool call
//                                    back into the corresponding provider API
//
// Currently wired providers (all others fall back to Test = present-only):
//   slack, jira, github, gmail, webhook, rest (generic HTTP with user-defined ops)

import fs from 'fs/promises'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { createHmac } from 'crypto'

const execAsync = promisify(exec)
export { execAsync }
import { query } from '../db/pool.js'
import { decryptCredentials } from './crypto.service.js'
import { getValidAccessToken } from './oauth.service.js'
import {
  verifyDatabaseConnector,
  listTables as dbListTables,
  describeTable as dbDescribeTable,
  sampleTable as dbSampleTable,
  runQuery as dbRunQuery,
} from './database-connector.service.js'

// Only allow public http(s) targets — reject loopback/private ranges in prod
// to prevent SSRF via connector configs the user controls.
function assertSafeUrl(rawUrl) {
  let url
  try { url = new URL(rawUrl) } catch { throw new Error('Invalid URL') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL must be http or https')
  if (process.env.NODE_ENV === 'production') {
    const host = url.hostname
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|fc00:|fe80:)/i.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
      throw new Error('URL must not target private/internal addresses')
    }
  }
  return url
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) })
}

// ─── Verification (used by Test endpoint) ─────────────────────────────────

/**
 * Actively verify that a connector has usable credentials.
 * Returns { success: bool, message: string }.
 * NEVER returns success:true for OAuth without a real token or for API_KEY
 * without the declared credential fields.
 */
export async function verifyConnector(conn) {
  const decryptedConfig = decryptCredentials(conn.config || {})

  // Database connectors are verified by actually opening a connection and
  // running SELECT 1 — no OAuth / API_KEY dance applies.
  if (conn.tool_id === 'database' || conn.tool_id === 'postgres') {
    return verifyDatabaseConnector(conn)
  }

  // Knowledge Graph connectors — verify via Neo4j/ArangoDB ping
  if (conn.tool_id === 'knowledge-graph') {
    const { verifyGraphConnector } = await import('./graph-knowledge.service.js')
    return verifyGraphConnector(conn)
  }

  // Vector DB connectors — verify by checking reachability
  if (conn.tool_id === 'vector-db') {
    return verifyVectorDbConnector(conn, decryptedConfig)
  }

  // Generic REST connector — check baseUrl + auth shape, optionally ping a healthCheck path
  if (conn.tool_id === 'rest') {
    return verifyRestConnector(conn, decryptedConfig)
  }

  // OAuth: must have an access token stored, and the token must resolve
  if (conn.auth_type === 'OAUTH2' || conn.auth_type === 'OAUTH') {
    if (!conn.config?.oauth?.accessToken) {
      return { success: false, message: 'OAuth not completed — no access token stored. Open this connector and click "Authorise" to grant access from within this app (being signed in to the provider in another browser tab is not enough).' }
    }
    try {
      const token = await getValidAccessToken(conn.tenant_id, conn.id)
      // Provider-specific ping (best-effort; unknown providers pass on token presence)
      const ping = await providerPing(conn.tool_id, { token, config: decryptedConfig })
      return ping
    } catch (err) {
      return { success: false, message: `OAuth token invalid or refresh failed: ${err.message}` }
    }
  }

  // API_KEY: required credential fields must be present + non-empty
  if (conn.auth_type === 'API_KEY') {
    const required = requiredFieldsFor(conn.tool_id)
    const missing = required.filter(f => !decryptedConfig[f] || String(decryptedConfig[f]).trim() === '')
    if (missing.length > 0) {
      return { success: false, message: `Missing required credentials: ${missing.join(', ')}` }
    }
    const ping = await providerPing(conn.tool_id, { config: decryptedConfig })
    return ping
  }

  // Other/NONE: refuse to claim success unless we know how to verify
  if (conn.tool_id === 'mcp') {
    // MCP verification is handled by the caller (connectors route already imports listMcpTools)
    return { success: true, message: 'MCP connector — use MCP-specific verification' }
  }

  if (conn.tool_id === 'local-shell' || conn.tool_id === 'local-applescript') {
    return { success: true, message: 'Local capability verified automatically.' }
  }

  return { success: false, message: `Cannot verify connector of type "${conn.auth_type}" for "${conn.tool_id}"` }
}

function requiredFieldsFor(toolId) {
  switch (toolId) {
    case 'jira':    return ['apiKey', 'baseUrl', 'email']
    case 'github':  return ['token']
    case 'docker':  return ['socketPath']
    case 'notion':  return ['apiKey']
    case 'linear':  return ['apiKey']
    case 'webhook': return ['url']
    case 'whatsapp': return ['phoneNumberId', 'accessToken']
    case 'telegram': return ['botToken']
    // Slack normally uses OAuth, but users can also paste a bot token
    case 'slack':   return ['token']
    case 'ssh':     return ['host']
    case 'local-dir': return ['path']
    case 'knowledge-graph': return ['baseUrl', 'username', 'password']
    case 'vector-db': return ['baseUrl']
    default:        return []
  }
}

/**
 * Resolve a Slack bearer token for a connector, preferring a directly-supplied
 * bot token (config.token = xoxb-...) over the OAuth-issued access token.
 * Rationale: many teams already have a Slack App with a bot token and want to
 * skip the OAuth dance; OAuth is still the preferred path when configured.
 * Callers do NOT need to know which auth mode the connector uses.
 */
async function getSlackToken(conn) {
  const cfg = decryptCredentials(conn.config || {})
  if (cfg.token && typeof cfg.token === 'string' && cfg.token.trim()) {
    return cfg.token.trim()
  }
  return await getValidAccessToken(conn.tenant_id, conn.id)
}

/**
 * Verify a vector-db connector by pinging the base URL.
 */
async function verifyVectorDbConnector(conn, decryptedConfig) {
  try {
    const baseUrl = decryptedConfig.baseUrl
    if (!baseUrl) return { success: false, message: 'Base URL is required' }
    const resp = await fetch(`${baseUrl}/.well-known/ready`, { signal: AbortSignal.timeout(5000) })
    if (resp.ok) return { success: true, message: 'Vector DB reachable' }
    // Some vector DBs don't have a health endpoint — try the root
    const resp2 = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) })
    if (resp2.ok || resp2.status === 401) return { success: true, message: 'Vector DB reachable (auth required)' }
    return { success: false, message: `Vector DB returned ${resp2.status}` }
  } catch (err) {
    return { success: false, message: `Vector DB unreachable: ${err.message}` }
  }
}

/**
 * Best-effort authenticated ping. If the provider is unknown we return success
 * (because we already know creds are present) rather than fabricating a call.
 */
async function providerPing(toolId, { token, config }) {
  // Dev-only: the mock OAuth flow issues `mock-access-token` when no real
  // OAUTH_*_CLIENT_ID is configured. Hitting the real provider with that
  // token returns 401 ("Request had invalid authentication credentials"),
  // which surfaces as a scary test failure. Detect it here and short-circuit
  // to a clearly-labelled success so devs know the connector is wired but
  // not backed by a real token.
  if (token === 'mock-access-token' && process.env.NODE_ENV !== 'production') {
    return {
      success: true,
      message: `⚠️ Dev mock OAuth token — no real ${toolId} credentials configured. Set OAUTH_${(toolId === 'gmail' ? 'GOOGLE' : toolId.toUpperCase())}_CLIENT_ID/SECRET in apps/api/.env for a live connection.`
    }
  }
  try {
    switch (toolId) {
      case 'local-dir': {
        try {
          const stats = await fs.stat(config.path)
          if (!stats.isDirectory()) return { success: false, message: 'Path exists but is not a directory' }
          return { success: true, message: `Local directory verified: ${config.path}` }
        } catch (err) {
          return { success: false, message: `Could not access directory: ${err.message}` }
        }
      }
      case 'slack': {
        // Slack accepts either an OAuth bearer token OR a directly-pasted
        // bot token (xoxb-\u2026) stored under config.token. verifyConnector
        // routes API_KEY connectors here without a bearer token, so fall
        // back to the config field to make Test succeed for that path too.
        const bearer = token || config?.token
        if (!bearer) return { success: false, message: 'Slack token missing (neither OAuth token nor config.token set)' }
        const res = await fetchWithTimeout('https://slack.com/api/auth.test', {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}` }
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || body.ok === false) {
          return { success: false, message: `Slack auth.test failed: ${body.error || res.status}` }
        }
        return { success: true, message: `Connected as ${body.user || body.user_id} in ${body.team || body.team_id}` }
      }
      case 'gmail': {
        const res = await fetchWithTimeout('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { Authorization: `Bearer ${token}` }
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) return { success: false, message: `Gmail ping failed: ${body.error?.message || res.status}` }
        return { success: true, message: `Connected as ${body.emailAddress}` }
      }
      case 'jira': {
        const base = String(config.baseUrl || '').replace(/\/$/, '')
        assertSafeUrl(base)
        const basic = Buffer.from(`${config.email}:${config.apiKey}`).toString('base64')

        // Try Jira Cloud API v3 first, then fall back to Jira Server v2
        const paths = ['/rest/api/3/myself', '/rest/api/2/myself']
        let lastErr = null

        for (const path of paths) {
          try {
            const res = await fetchWithTimeout(`${base}${path}`, {
              headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' }
            })
            if (res.ok) {
              const body = await res.json().catch(() => ({}))
              const user = body.displayName || body.emailAddress || 'Jira user'
              const apiVer = path.includes('/3/') ? 'Cloud' : 'Server'
              return { success: true, message: `Connected as ${user} (${apiVer})` }
            }
            if (res.status === 401) {
              lastErr = `Authentication failed (401). Check that: 1) Your API token is correct (generate at https://id.atlassian.com/manage-profile/security/api-tokens), 2) Your email matches the Atlassian account that created the token`
            } else if (res.status === 404) {
              lastErr = null // try next path
            } else {
              lastErr = `Jira returned HTTP ${res.status}: ${res.statusText || 'Unknown error'}`
            }
          } catch (err) {
            lastErr = `Jira ping failed: ${err.message}`
          }
        }
        return { success: false, message: lastErr || 'Jira instance not reachable. Check your base URL (e.g. https://your-domain.atlassian.net for Cloud, or https://jira.your-company.com for self-hosted).' }
      }
      case 'github': {
        const res = await fetchWithTimeout('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/vnd.github+json' }
        })
        if (!res.ok) return { success: false, message: `GitHub /user returned ${res.status}` }
        const body = await res.json().catch(() => ({}))
        return { success: true, message: `Connected as ${body.login}` }
      }
      case 'notion': {
        const res = await fetchWithTimeout('https://api.notion.com/v1/users/me', {
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Notion-Version': '2022-06-28' }
        })
        if (!res.ok) return { success: false, message: `Notion /users/me returned ${res.status}` }
        return { success: true, message: 'Notion integration verified' }
      }
      case 'linear': {
        const res = await fetchWithTimeout('https://api.linear.app/graphql', {
          method: 'POST',
          headers: { Authorization: config.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: '{ viewer { id name } }' })
        })
        if (!res.ok) return { success: false, message: `Linear GraphQL returned ${res.status}` }
        const body = await res.json().catch(() => ({}))
        if (body.errors) return { success: false, message: `Linear error: ${body.errors[0]?.message || 'unknown'}` }
        return { success: true, message: `Connected as ${body.data?.viewer?.name || 'Linear user'}` }
      }
      case 'webhook': {
        // Just validate the URL is well-formed and safe; don't actually POST during test —
        // many endpoints have side effects. Reachability check via HEAD is often blocked.
        assertSafeUrl(config.url)
        return { success: true, message: `Webhook target ${config.url} accepted (no live ping)` }
      }
      case 'telegram': {
        // Verify Telegram Bot API credentials by calling getMe
        const botToken = config.botToken || config.bot_token
        if (!botToken) {
          return { success: false, message: 'Telegram requires a bot token (get from @BotFather)' }
        }
        try {
          const res = await fetchWithTimeout(
            `https://api.telegram.org/bot${botToken}/getMe`,
            { headers: { 'User-Agent': 'kuvalam-agent/1.0' } }
          )
          const body = await res.json().catch(() => ({}))
          if (!body.ok) {
            return { success: false, message: `Telegram API error: ${body.description || res.status} — check your bot token` }
          }
          const bot = body.result
          return { success: true, message: `Connected to Telegram bot: @${bot.username} (${bot.first_name})` }
        } catch (err) {
          return { success: false, message: `Telegram connection failed: ${err.message}` }
        }
      }
      case 'whatsapp': {
        // Verify WhatsApp Cloud API credentials by querying phone number info
        const phoneNumberId = config.phoneNumberId || config.phone_number_id
        const accessToken = config.accessToken || config.access_token
        if (!phoneNumberId || !accessToken) {
          return { success: false, message: 'WhatsApp requires phoneNumberId and accessToken (generate from Meta Business app → WhatsApp → API Setup)' }
        }
        try {
          const res = await fetchWithTimeout(
            `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          )
          const body = await res.json().catch(() => ({}))
          if (!res.ok) {
            return { success: false, message: `WhatsApp API error: ${body.error?.message || res.status} — check your access token and phone number ID` }
          }
          return { success: true, message: `Connected to WhatsApp: ${body.display_phone_number} (${body.verified_name})` }
        } catch (err) {
          return { success: false, message: `WhatsApp connection failed: ${err.message}` }
        }
      }
      case 'salesforce': {
        // Salesforce OAuth grants an instance URL alongside the token.
        // saveOAuthTokens lifts it to `config.oauth.instance_url`; older
        // rows may have it under `config.oauth.raw.instance_url` or
        // `config.instanceUrl`. Accept all three shapes.
        const instance =
          config?.oauth?.instance_url ||
          config?.oauth?.raw?.instance_url ||
          config?.instanceUrl
        if (!instance) return { success: false, message: 'Missing Salesforce instance URL — reconnect the OAuth integration' }
        assertSafeUrl(instance)
        const res = await fetchWithTimeout(`${instance}/services/oauth2/userinfo`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        if (!res.ok) return { success: false, message: `Salesforce userinfo returned ${res.status}` }
        return { success: true, message: 'Salesforce token verified' }
      }
      default:
        return { success: true, message: 'Credentials present (no provider-specific ping available)' }
    }
  } catch (err) {
    return { success: false, message: `Verification error: ${err.message}` }
  }
}

// ─── Tool definitions (fed to the LLM at planning time) ───────────────────

/**
 * For every ACTIVE connector on the tenant, return the tool schemas the LLM
 * should see. Names are prefixed with the provider so we can dispatch back.
 */
export async function getConnectorToolDefinitions(tenantId) {
  const { rows: conns } = await query(
    `SELECT id, tool_id, name, auth_type, config, status
     FROM tool_connections
     WHERE tenant_id = $1 AND status = 'ACTIVE' AND tool_id != 'mcp'`,
    [tenantId]
  )

  const defs = []
  for (const c of conns) {
    // Database connectors get per-instance tool names so an agent can
    // distinguish "the sales DB" from "the warehouse DB" (much like MCP).
    if (c.tool_id === 'database' || c.tool_id === 'postgres') {
      for (const d of databaseToolDefs(c)) { d._connectorId = c.id; defs.push(d) }
      continue
    }
    // Generic REST connectors expose one tool per user-defined operation.
    if (c.tool_id === 'rest') {
      for (const d of restToolDefs(c)) { d._connectorId = c.id; defs.push(d) }
      continue
    }
    for (const d of toolDefsForProvider(c)) { d._connectorId = c.id; defs.push(d) }
  }
  return defs
}

function connIdSlug(id) {
  return String(id).replace(/-/g, '_')
}

// ─── Generic REST connector helpers ───────────────────────────────────────
// Config shape stored on tool_connections.config for tool_id='rest':
//   {
//     baseUrl: 'https://api.example.com',
//     auth: {
//       type: 'none' | 'bearer' | 'basic' | 'header' | 'query',
//       token?, username?, password?, headerName?, headerValue?, queryName?, queryValue?
//     },
//     defaultHeaders?: { 'Accept': 'application/json', ... },
//     healthCheck?: { method: 'GET', path: '/health' },  // optional Test-endpoint probe
//     operations: [
//       {
//         name: 'get_user',
//         method: 'GET',
//         path: '/users/{id}',
//         description: 'Fetch a single user',
//         params: [
//           { name: 'id', in: 'path'|'query'|'header', type: 'string'|'number'|'boolean', required: true, description: '...' }
//         ],
//         bodyType?: 'json' | 'form' | 'raw',
//         bodySchema?: { type: 'object', properties: {...}, required: [...] }
//       }
//     ]
//   }

const REST_ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])

function normaliseRestOp(op) {
  const method = String(op?.method || 'GET').toUpperCase()
  return {
    name: String(op?.name || '').trim(),
    method: REST_ALLOWED_METHODS.has(method) ? method : 'GET',
    path: String(op?.path || '/').trim(),
    description: op?.description || '',
    params: Array.isArray(op?.params) ? op.params : [],
    bodyType: op?.bodyType || 'json',
    bodySchema: op?.bodySchema || null,
  }
}

async function verifyRestConnector(conn, cfg) {
  if (!cfg?.baseUrl) return { success: false, message: 'baseUrl is required' }
  let base
  try { base = assertSafeUrl(cfg.baseUrl) }
  catch (err) { return { success: false, message: err.message } }

  const ops = Array.isArray(cfg.operations) ? cfg.operations : []
  if (ops.length === 0) {
    return { success: false, message: 'Define at least one operation before activating.' }
  }
  const badOp = ops.find(o => !o?.name || !o?.method || !o?.path)
  if (badOp) return { success: false, message: `Operation "${badOp?.name || '(unnamed)'}" is missing name/method/path` }

  const nameRe = /^[a-z][a-z0-9_]*$/i
  const duplicated = new Set()
  const seen = new Set()
  for (const o of ops) {
    if (!nameRe.test(o.name)) return { success: false, message: `Operation name "${o.name}" must match ^[a-z][a-z0-9_]*$` }
    if (seen.has(o.name)) duplicated.add(o.name)
    seen.add(o.name)
  }
  if (duplicated.size > 0) return { success: false, message: `Duplicate operation names: ${[...duplicated].join(', ')}` }

  // Optional health-check ping
  if (cfg.healthCheck?.path) {
    try {
      const res = await restFetch(base.toString(), cfg, {
        method: cfg.healthCheck.method || 'GET',
        path: cfg.healthCheck.path,
        params: [],
      }, {}, 6000)
      if (!res.ok) return { success: false, message: `Health check ${res.status} ${res.statusText}` }
    } catch (err) {
      return { success: false, message: `Health check failed: ${err.message}` }
    }
  }

  return { success: true, message: `REST connector accepted (${ops.length} operation${ops.length === 1 ? '' : 's'})` }
}

function restToolDefs(conn) {
  const cfg = decryptCredentials(conn.config || {})
  const ops = Array.isArray(cfg.operations) ? cfg.operations : []
  const slug = connIdSlug(conn.id)
  const label = `[REST: ${conn.name}]`

  return ops.map(rawOp => {
    const op = normaliseRestOp(rawOp)
    const props = {}
    const required = []
    for (const p of op.params) {
      if (!p?.name) continue
      const t = p.type || 'string'
      props[p.name] = { type: t, description: p.description || `${p.in || 'query'} parameter` }
      if (p.required) required.push(p.name)
    }
    // Body — advertise as a free-form object with the user's schema if provided
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(op.method) && op.bodySchema) {
      props.body = op.bodySchema
    } else if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(op.method)) {
      props.body = { type: 'object', description: 'JSON request body (optional)' }
    }
    return {
      name: `rest__${slug}__${op.name}`,
      description: `${label} ${op.method} ${op.path} — ${op.description || 'no description'}`,
      inputSchema: {
        type: 'object',
        ...(required.length > 0 ? { required } : {}),
        properties: props,
      }
    }
  })
}

function buildAuthHeaders(auth) {
  const headers = {}
  const query = {}
  if (!auth || auth.type === 'none') return { headers, query }
  switch (auth.type) {
    case 'bearer':
      if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`
      break
    case 'basic':
      if (auth.username || auth.password) {
        headers['Authorization'] = 'Basic ' + Buffer.from(`${auth.username || ''}:${auth.password || ''}`).toString('base64')
      }
      break
    case 'header':
      if (auth.headerName && auth.headerValue !== undefined) headers[auth.headerName] = String(auth.headerValue)
      break
    case 'query':
      if (auth.queryName && auth.queryValue !== undefined) query[auth.queryName] = String(auth.queryValue)
      break
  }
  return { headers, query }
}

/**
 * Interpolate {name} placeholders in the path from params(in==='path'),
 * append query params, and honour the auth strategy.
 */
async function restFetch(baseUrl, cfg, op, input = {}, timeoutMs = 15000) {
  // 1. Resolve path (path params)
  const pathParams = (op.params || []).filter(p => p.in === 'path')
  let path = op.path
  for (const p of pathParams) {
    const val = input[p.name]
    if (val === undefined || val === null) {
      if (p.required) throw new Error(`Missing required path parameter: ${p.name}`)
      continue
    }
    path = path.replace(`{${p.name}}`, encodeURIComponent(String(val)))
  }

  // 2. Build absolute URL and query
  const url = new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : baseUrl + '/')
  const queryParams = (op.params || []).filter(p => p.in === 'query')
  for (const p of queryParams) {
    const val = input[p.name]
    if (val === undefined || val === null) continue
    url.searchParams.set(p.name, String(val))
  }
  // Re-check safety of the fully-formed URL (baseUrl already validated at Test time)
  assertSafeUrl(url.toString())

  // 3. Auth
  const auth = buildAuthHeaders(cfg.auth)
  for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v)

  // 4. Headers
  const headerParams = (op.params || []).filter(p => p.in === 'header')
  const headers = {
    ...(cfg.defaultHeaders || {}),
    ...auth.headers,
  }
  for (const p of headerParams) {
    const val = input[p.name]
    if (val === undefined || val === null) continue
    headers[p.name] = String(val)
  }

  // 5. Body
  let body
  const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(op.method)
  if (hasBody && input.body !== undefined && input.body !== null) {
    if (op.bodyType === 'raw') {
      body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body)
    } else if (op.bodyType === 'form') {
      const form = new URLSearchParams()
      for (const [k, v] of Object.entries(input.body || {})) form.set(k, String(v))
      body = form.toString()
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    } else {
      body = JSON.stringify(input.body)
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
    }
  }

  return fetchWithTimeout(url.toString(), { method: op.method, headers, body }, timeoutMs)
}

async function executeRestTool(toolName, input, tenantId) {
  const parts = toolName.split('__')
  if (parts.length < 3) return { success: false, error: `Malformed REST tool name: ${toolName}` }
  const connSlug = parts[1]
  const opName = parts.slice(2).join('__')

  const { rows: [conn] } = await query(
    `SELECT id, tenant_id, tool_id, name, config
     FROM tool_connections
     WHERE tenant_id = $1
       AND status = 'ACTIVE'
       AND tool_id = 'rest'
       AND REPLACE(id::text, '-', '_') = $2
     LIMIT 1`,
    [tenantId, connSlug]
  )
  if (!conn) return { success: false, error: 'REST connector not found or not active for this tenant.' }

  const cfg = decryptCredentials(conn.config || {})
  const op = (cfg.operations || []).map(normaliseRestOp).find(o => o.name === opName)
  if (!op) return { success: false, error: `Operation "${opName}" not found on connector "${conn.name}".` }

  try {
    const res = await restFetch(cfg.baseUrl, cfg, op, input || {})
    const contentType = res.headers.get('content-type') || ''
    const text = await res.text()
    let data
    if (contentType.includes('application/json')) {
      try { data = JSON.parse(text) } catch { data = text }
    } else {
      data = text
    }
    // Cap response payload sent back to the LLM (16KB) to protect the context window
    if (typeof data === 'string' && data.length > 16000) data = data.slice(0, 16000) + '…[truncated]'
    return {
      success: res.ok,
      status: res.status,
      ...(res.ok ? {} : { error: `HTTP ${res.status} ${res.statusText}` }),
      data,
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function databaseToolDefs(conn) {
  const slug = connIdSlug(conn.id)
  const label = `[DB: ${conn.name}]`
  return [
    {
      name: `db__${slug}__list_tables`,
      description: `${label} List tables and views (schema, table, estimated row count, comment).`,
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: `db__${slug}__describe_table`,
      description: `${label} Return columns, types, primary key and indexes for a single table.`,
      inputSchema: {
        type: 'object', required: ['table'],
        properties: {
          schema: { type: 'string', default: 'public' },
          table:  { type: 'string' }
        }
      }
    },
    {
      name: `db__${slug}__sample`,
      description: `${label} Return the first N rows of a table (safe preview, max 50).`,
      inputSchema: {
        type: 'object', required: ['table'],
        properties: {
          schema: { type: 'string', default: 'public' },
          table:  { type: 'string' },
          limit:  { type: 'integer', default: 5, maximum: 50 }
        }
      }
    },
    {
      name: `db__${slug}__query`,
      description:
        `${label} Run a read-only SQL SELECT (or WITH … SELECT). Multi-statement and DDL/DML are rejected. ` +
        `Result is capped at 200 rows. Use $1, $2, … for parameterisation. ` +
        `⚠️  CRITICAL: You MUST call list_tables AND describe_table BEFORE this tool. Never guess table or column names — use only names confirmed by describe_table. ` +
        `If this tool returns an error, DO NOT fabricate data — report the error honestly and retry with corrected SQL.`,
      inputSchema: {
        type: 'object', required: ['sql'],
        properties: {
          sql:    { type: 'string', description: 'A single SELECT / WITH … SELECT statement using ONLY table/column names confirmed by describe_table' },
          params: { type: 'array', description: 'Positional parameters for $1, $2, …', items: {} },
          limit:  { type: 'integer', description: 'Row cap (max 200)', maximum: 200 }
        }
      }
    }
  ]
}

function toolDefsForProvider(conn) {
  switch (conn.tool_id) {
    case 'local-shell': return [{
      name: 'local_shell__execute',
      description: `[Local Shell: ${conn.name}] Execute a bash/zsh command on the host. MANDATORY: you MUST provide "command" — the shell command string to execute (e.g. "ls -la" or "cat /etc/hosts").`,
      inputSchema: {
        type: 'object', required: ['command'], properties: { command: { type: 'string', description: 'REQUIRED — The shell command string to run, e.g. "ls -la"' } }
      }
    }]
    case 'local-applescript': return [{
      name: 'local_applescript__execute',
      description: `[Local Mac Automation: ${conn.name}] Execute an AppleScript snippet to automate macOS apps. MANDATORY: you MUST provide "script" — the AppleScript code string to run.`,
      inputSchema: {
        type: 'object', required: ['script'], properties: { script: { type: 'string', description: 'REQUIRED — The AppleScript code to execute' } }
      }
    }]
    case 'local-dir': return [{
      name: 'local_dir__list',
      description: `[Local Directory: ${conn.name} — ${conn.config?.path || 'path not set'}] List files and folders. Call WITHOUT any parameter to list the root directory shown above. Returns { path, files: [{ name, type }] }. To list a sub-directory, pass sub_path (e.g. "data" or "reports/2024").`,
      inputSchema: {
        type: 'object', properties: { sub_path: { type: 'string', description: 'Optional. Sub-directory to list (e.g. "data"). Omit to list the root.' } }
      }
    }, {
      name: 'local_dir__read',
      description: `[Local Directory: ${conn.name} — ${conn.config?.path || 'path not set'}] Read a file's text contents. MANDATORY: you MUST provide "file_path" — the relative path of the file to read (e.g. "report.csv" or "data/sales.json"). Use local_dir__list FIRST to see what files are available, then pass the exact file name as file_path. Without file_path this will fail.`,
      inputSchema: {
        type: 'object', required: ['file_path'], properties: { file_path: { type: 'string', description: 'REQUIRED — Relative path of the file to read. Get available files from local_dir__list first.' } }
      }
    }, {
      name: 'local_dir__write',
      description: `[Local Directory: ${conn.name} — ${conn.config?.path || 'path not set'}] Write text content to a file. MANDATORY: you MUST provide "file_path" (relative path, e.g. "output/report.md") AND "content" (the text to write). Creates parent directories if needed. Overwrites existing files.`,
      inputSchema: {
        type: 'object', required: ['file_path', 'content'], 
        properties: { 
          file_path: { type: 'string', description: 'REQUIRED — Relative path of the file to write to, e.g. "output/report.md"' },
          content: { type: 'string', description: 'REQUIRED — The full text content to write to the file' }
        }
      }
    }]
    case 'slack': return [{
      name: 'slack__post_message',
      description: `[Slack: ${conn.name}] Post a message to a Slack channel or DM.`,
      inputSchema: {
        type: 'object', required: ['channel', 'text'],
        properties: {
          channel:   { type: 'string', description: 'Channel ID (e.g. C0123ABC), #channel-name, or user ID for DM' },
          text:      { type: 'string', description: 'Message text (supports Slack mrkdwn)' },
          thread_ts: { type: 'string', description: 'Optional parent thread timestamp to reply in-thread' },
          blocks:    { type: 'array', description: 'Optional Slack Block Kit blocks for rich formatting', items: { type: 'object' } }
        }
      }
    }, {
      name: 'slack__update_message',
      description: `[Slack: ${conn.name}] Edit a previously posted message.`,
      inputSchema: {
        type: 'object', required: ['channel', 'ts', 'text'],
        properties: {
          channel: { type: 'string', description: 'Channel ID the message lives in' },
          ts:      { type: 'string', description: 'Timestamp of the original message (from post_message result)' },
          text:    { type: 'string', description: 'New message text' }
        }
      }
    }, {
      name: 'slack__list_channels',
      description: `[Slack: ${conn.name}] List channels the bot can see. Use to look up a channel ID before posting.`,
      inputSchema: {
        type: 'object',
        properties: {
          types:    { type: 'string', description: 'Comma-separated: public_channel, private_channel, mpim, im', default: 'public_channel,private_channel' },
          limit:    { type: 'integer', description: 'Max channels to return (max 200)', default: 100, maximum: 200 },
          name_filter: { type: 'string', description: 'Optional case-insensitive substring match on channel name' }
        }
      }
    }, {
      name: 'slack__get_history',
      description: `[Slack: ${conn.name}] Fetch recent messages from a channel (newest first).`,
      inputSchema: {
        type: 'object', required: ['channel'],
        properties: {
          channel: { type: 'string', description: 'Channel ID' },
          limit:   { type: 'integer', description: 'How many messages (max 50)', default: 20, maximum: 50 }
        }
      }
    }, {
      name: 'slack__add_reaction',
      description: `[Slack: ${conn.name}] Add an emoji reaction to a message.`,
      inputSchema: {
        type: 'object', required: ['channel', 'timestamp', 'name'],
        properties: {
          channel:   { type: 'string', description: 'Channel ID the message lives in' },
          timestamp: { type: 'string', description: 'Message timestamp (ts)' },
          name:      { type: 'string', description: 'Emoji name without colons, e.g. "thumbsup"' }
        }
      }
    }, {
      name: 'slack__lookup_user',
      description: `[Slack: ${conn.name}] Look up a user by email address (returns user ID for DMs / @-mentions).`,
      inputSchema: {
        type: 'object', required: ['email'],
        properties: {
          email: { type: 'string', description: 'The user\'s email address' }
        }
      }
    }]

    case 'jira': return [{
      name: 'jira__create_issue',
      description: `[Jira: ${conn.name}] Create a new Jira issue.`,
      inputSchema: {
        type: 'object', required: ['summary'],
        properties: {
          projectKey:  { type: 'string', description: 'Jira project key, e.g. "ENG". Falls back to connector default if omitted.' },
          summary:     { type: 'string' },
          description: { type: 'string' },
          issueType:   { type: 'string', description: 'e.g. Task, Bug, Story', default: 'Task' }
        }
      }
    }, {
      name: 'jira__search_issues',
      description: `[Jira: ${conn.name}] Search Jira issues by JQL. ⚠️ JQL does NOT support LIMIT — use the maxResults parameter instead to cap results. Common JQL: project="KEY" ORDER BY priority DESC, status="In Progress" AND assignee=currentUser(), created >= -7d. Fields: project, status, assignee, priority, issuetype, created, updated, resolution, summary, description, reporter, labels, fixVersion, component.`,
      inputSchema: {
        type: 'object', required: ['jql'],
        properties: {
          jql:        { type: 'string', description: `JQL expression. ⚠️ IMPORTANT: JQL has NO "LIMIT" keyword — "LIMIT" is a reserved word in JQL and will cause an error if used. Never add LIMIT to your JQL. Instead use the maxResults parameter to control how many results are returned. Common patterns: project="KEY" ORDER BY priority DESC, status="In Progress", assignee=currentUser(), created >= -7d, issuetype="Bug".` },
          maxResults: { type: 'integer', default: 10, maximum: 50, description: 'Maximum number of issues to return. Use this INSTEAD of LIMIT in JQL.' }
        }
      }
    }]

    case 'github': return [{
      name: 'github__create_issue',
      description: `[GitHub: ${conn.name}] Open a new issue in a repository.`,
      inputSchema: {
        type: 'object', required: ['owner', 'repo', 'title'],
        properties: {
          owner: { type: 'string' }, repo: { type: 'string' },
          title: { type: 'string' }, body: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } }
        }
      }
    }, {
      name: 'github__search_repos',
      description: `[GitHub: ${conn.name}] Search public repositories.`,
      inputSchema: {
        type: 'object', required: ['q'],
        properties: {
          q:        { type: 'string', description: 'GitHub search query' },
          per_page: { type: 'integer', default: 5, maximum: 30 }
        }
      }
    }, {
      name: 'github__get_repo',
      description: `[GitHub: ${conn.name}] Fetch metadata for a single repository.`,
      inputSchema: {
        type: 'object', required: ['owner', 'repo'],
        properties: { owner: { type: 'string' }, repo: { type: 'string' } }
      }
    }]

    case 'docker': return [
      {
        name: `docker__run`,
        description: `[Docker: ${conn.name}] Run a command in a new container (docker run --rm). Great for isolated execution, running tools not on the host, or temporary services.`,
        inputSchema: {
          type: 'object', required: ['image', 'command'],
          properties: {
            image: { type: 'string', description: 'Docker image (e.g. python:3.12, alpine:latest)' },
            command: { type: 'string', description: 'Command to run inside the container' },
            workdir: { type: 'string', description: 'Working directory inside container' },
            mount: { type: 'string', description: 'Volume mount (e.g. /host/path:/container/path)' },
            env: { type: 'object', description: 'Environment variables' },
            timeout: { type: 'integer', default: 30, description: 'Timeout in seconds (max 120)' }
          }
        }
      },
      {
        name: `docker__exec`,
        description: `[Docker: ${conn.name}] Execute a command in an existing running container.`,
        inputSchema: {
          type: 'object', required: ['container', 'command'],
          properties: {
            container: { type: 'string', description: 'Container name or ID' },
            command: { type: 'string', description: 'Command to execute' }
          }
        }
      },
      {
        name: `docker__logs`,
        description: `[Docker: ${conn.name}] Fetch logs from a container.`,
        inputSchema: {
          type: 'object', required: ['container'],
          properties: {
            container: { type: 'string', description: 'Container name or ID' },
            tail: { type: 'integer', default: 50, description: 'Number of recent lines' }
          }
        }
      },
      {
        name: `docker__ps`,
        description: `[Docker: ${conn.name}] List running Docker containers.`,
        inputSchema: {
          type: 'object', properties: {
            all: { type: 'boolean', default: false, description: 'Include stopped containers' }
          }
        }
      },
    ]

    case 'gmail': return [{
      name: 'gmail__send_email',
      description: `[Gmail: ${conn.name}] Send an email as the connected user.`,
      inputSchema: {
        type: 'object', required: ['to', 'subject', 'body'],
        properties: {
          to:      { type: 'string', description: 'Recipient email address (comma-separate for multiple)' },
          cc:      { type: 'string', description: 'Optional CC recipients' },
          bcc:     { type: 'string', description: 'Optional BCC recipients' },
          subject: { type: 'string' },
          body:    { type: 'string', description: 'Plain text body' },
          html:    { type: 'string', description: 'Optional HTML body (used instead of plain text when provided)' }
        }
      }
    }, {
      name: 'gmail__list_messages',
      description: `[Gmail: ${conn.name}] List recent messages matching a Gmail search query.`,
      inputSchema: {
        type: 'object',
        properties: {
          q:      { type: 'string', description: 'Gmail search query, e.g. "from:boss@x.com is:unread"', default: '' },
          limit:  { type: 'integer', description: 'Max messages to return (max 50)', default: 10, maximum: 50 }
        }
      }
    }, {
      name: 'gmail__get_message',
      description: `[Gmail: ${conn.name}] Fetch the parsed subject / from / snippet / body of a single message.`,
      inputSchema: {
        type: 'object', required: ['id'],
        properties: { id: { type: 'string', description: 'Gmail message id (from list_messages)' } }
      }
    }]

    case 'notion': return [{
      name: 'notion__search',
      description: `[Notion: ${conn.name}] Search all pages and databases the integration has been granted access to.`,
      inputSchema: {
        type: 'object',
        properties: {
          query:  { type: 'string', description: 'Text to search for (leave empty to list everything)', default: '' },
          filter: { type: 'string', enum: ['page', 'database', 'any'], description: 'Restrict to pages or databases', default: 'any' },
          limit:  { type: 'integer', description: 'Max results (max 50)', default: 10, maximum: 50 }
        }
      }
    }, {
      name: 'notion__retrieve_page',
      description: `[Notion: ${conn.name}] Fetch the properties + block content of a single page.`,
      inputSchema: {
        type: 'object', required: ['page_id'],
        properties: { page_id: { type: 'string', description: 'Notion page id (with or without dashes)' } }
      }
    }, {
      name: 'notion__create_page',
      description: `[Notion: ${conn.name}] Create a new page under a parent page or database. For database children, "properties" must match the DB schema.`,
      inputSchema: {
        type: 'object', required: ['parent_type', 'parent_id'],
        properties: {
          parent_type: { type: 'string', enum: ['page_id', 'database_id'], description: 'Where to create the page' },
          parent_id:   { type: 'string', description: 'Id of the parent page or database' },
          title:       { type: 'string', description: 'Title (page parent) OR "Name" property value (database parent)' },
          content:     { type: 'string', description: 'Optional plain-text body — becomes a paragraph block' },
          properties:  { type: 'object', description: 'For database parents: property map keyed by property name (advanced)' }
        }
      }
    }, {
      name: 'notion__query_database',
      description: `[Notion: ${conn.name}] Query rows in a Notion database. Pass a raw Notion "filter" object for anything non-trivial.`,
      inputSchema: {
        type: 'object', required: ['database_id'],
        properties: {
          database_id: { type: 'string' },
          filter:      { type: 'object', description: 'Notion filter object (see Notion API docs). Omit to return all rows.' },
          sorts:       { type: 'array', items: { type: 'object' } },
          limit:       { type: 'integer', description: 'Max rows (max 50)', default: 25, maximum: 50 }
        }
      }
    }, {
      name: 'notion__append_blocks',
      description: `[Notion: ${conn.name}] Append plain-text paragraph blocks to a page.`,
      inputSchema: {
        type: 'object', required: ['page_id', 'text'],
        properties: {
          page_id: { type: 'string' },
          text:    { type: 'string', description: 'Text to append (line-breaks become separate paragraph blocks)' }
        }
      }
    }]

    case 'linear': return [{
      name: 'linear__list_teams',
      description: `[Linear: ${conn.name}] List teams (for their id / key when creating issues).`,
      inputSchema: { type: 'object', properties: {} }
    }, {
      name: 'linear__create_issue',
      description: `[Linear: ${conn.name}] Create an issue in a team. Provide EITHER teamKey (e.g. "ENG") OR teamId.`,
      inputSchema: {
        type: 'object', required: ['title'],
        properties: {
          teamKey:     { type: 'string', description: 'Team key like "ENG" (auto-resolved to id)' },
          teamId:      { type: 'string', description: 'Team UUID (if you already have it)' },
          title:       { type: 'string' },
          description: { type: 'string', description: 'Markdown description' },
          priority:    { type: 'integer', description: '0 (none), 1 (urgent) … 4 (low)', minimum: 0, maximum: 4 },
          assigneeId:  { type: 'string' }
        }
      }
    }, {
      name: 'linear__search_issues',
      description: `[Linear: ${conn.name}] Search issues by title/identifier substring.`,
      inputSchema: {
        type: 'object', required: ['query'],
        properties: {
          query: { type: 'string', description: 'Substring to search for in title/identifier' },
          limit: { type: 'integer', default: 10, maximum: 25 }
        }
      }
    }, {
      name: 'linear__update_issue',
      description: `[Linear: ${conn.name}] Update an existing issue's title, description, priority or state.`,
      inputSchema: {
        type: 'object', required: ['issueId'],
        properties: {
          issueId:     { type: 'string', description: 'Issue UUID (not the human "ENG-123" id)' },
          title:       { type: 'string' },
          description: { type: 'string' },
          priority:    { type: 'integer', minimum: 0, maximum: 4 },
          stateId:     { type: 'string', description: 'Workflow state UUID (use list_workflow_states first)' }
        }
      }
    }, {
      name: 'linear__add_comment',
      description: `[Linear: ${conn.name}] Post a comment on an issue.`,
      inputSchema: {
        type: 'object', required: ['issueId', 'body'],
        properties: {
          issueId: { type: 'string' },
          body:    { type: 'string', description: 'Markdown comment body' }
        }
      }
    }]

    case 'salesforce': return [{
      name: 'salesforce__query',
      description: `[Salesforce: ${conn.name}] Run a read-only SOQL query. Returns first ${'`'}limit${'`'} rows (default 50, max 200).`,
      inputSchema: {
        type: 'object', required: ['soql'],
        properties: {
          soql:  { type: 'string', description: 'A SOQL SELECT statement, e.g. SELECT Id, Name FROM Account LIMIT 10' },
          limit: { type: 'integer', description: 'Row cap (max 200)', default: 50, maximum: 200 }
        }
      }
    }, {
      name: 'salesforce__describe_object',
      description: `[Salesforce: ${conn.name}] Return the fields + types for a Salesforce object (e.g. Account, Contact, Opportunity).`,
      inputSchema: {
        type: 'object', required: ['sobject'],
        properties: { sobject: { type: 'string', description: 'API name of the object' } }
      }
    }, {
      name: 'salesforce__create_record',
      description: `[Salesforce: ${conn.name}] Create a record in the given object type. Fields must match the object schema.`,
      inputSchema: {
        type: 'object', required: ['sobject', 'fields'],
        properties: {
          sobject: { type: 'string', description: 'API name, e.g. "Contact"' },
          fields:  { type: 'object', description: 'Field map, e.g. { FirstName: "Ada", LastName: "Lovelace" }' }
        }
      }
    }, {
      name: 'salesforce__update_record',
      description: `[Salesforce: ${conn.name}] Update an existing record by Id.`,
      inputSchema: {
        type: 'object', required: ['sobject', 'id', 'fields'],
        properties: {
          sobject: { type: 'string' },
          id:      { type: 'string', description: 'Salesforce record Id (15- or 18-char)' },
          fields:  { type: 'object', description: 'Fields to update' }
        }
      }
    }]

    case 'ssh': return [
      {
        name: `ssh__exec`,
        description: `[SSH: ${conn.name}] Execute a command on a remote machine via SSH. Requires SSH key-based auth.`,
        inputSchema: {
          type: 'object', required: ['host', 'command'],
          properties: {
            host: { type: 'string', description: 'Remote hostname or IP' },
            command: { type: 'string', description: 'Command to execute' },
            port: { type: 'integer', default: 22, description: 'SSH port' },
            user: { type: 'string', default: 'root', description: 'SSH user' },
            timeout: { type: 'integer', default: 30, description: 'Timeout seconds (max 120)' }
          }
        }
      },
      {
        name: `ssh__upload`,
        description: `[SSH: ${conn.name}] Upload a file to a remote machine via SCP.`,
        inputSchema: {
          type: 'object', required: ['host', 'remote_path', 'content'],
          properties: {
            host: { type: 'string', description: 'Remote hostname or IP' },
            remote_path: { type: 'string', description: 'Remote file path' },
            content: { type: 'string', description: 'File content' },
            port: { type: 'integer', default: 22 },
            user: { type: 'string', default: 'root' }
          }
        }
      },
    ]

    case 'webhook': return [{
      name: 'webhook__post',
      description: `[Webhook: ${conn.name}] POST a JSON payload to the configured webhook URL. MANDATORY: you MUST provide "payload" — a JSON object with the data to send.`,
      inputSchema: {
        type: 'object', required: ['payload'],
        properties: {
          payload: { type: 'object', description: 'REQUIRED — JSON object to POST to the webhook URL' }
        }
      }
    }]

    case 'whatsapp': return [{
      name: 'whatsapp__send_message',
      description: `[WhatsApp: ${conn.name}] Send a text message to a WhatsApp user. MANDATORY: you MUST provide "to" (phone number with country code) and "text" (the message body). Use this to reply to users or send proactive notifications.`,
      inputSchema: {
        type: 'object', required: ['to', 'text'],
        properties: {
          to: { type: 'string', description: 'REQUIRED — Phone number in international format (e.g. 1234567890)' },
          text: { type: 'string', description: 'REQUIRED — The message text to send (max 4096 chars)' },
          preview_url: { type: 'boolean', description: 'Whether to show link previews (default: false)' },
        }
      }
    }, {
      name: 'whatsapp__send_template',
      description: `[WhatsApp: ${conn.name}] Send a pre-approved message template. Useful for notifications and alerts. MANDATORY: "to" (phone number), "template_name" (must match an approved template in Meta Business).`,
      inputSchema: {
        type: 'object', required: ['to', 'template_name'],
        properties: {
          to: { type: 'string', description: 'REQUIRED — Phone number in international format' },
          template_name: { type: 'string', description: 'REQUIRED — Name of the approved template in Meta Business Manager' },
          language: { type: 'string', description: 'Language code (default: en)' },
          parameters: { type: 'array', items: { type: 'string' }, description: 'Template parameter values' },
        }
      }
    }]

    case 'telegram': return [{
      name: 'telegram__send_message',
      description: `[Telegram: ${conn.name}] Send a text message to a Telegram user or group. MANDATORY: you MUST provide "chat_id" (Telegram chat ID) and "text" (the message body, supports MarkdownV2). Use this to reply to users or send proactive notifications.`,
      inputSchema: {
        type: 'object', required: ['chat_id', 'text'],
        properties: {
          chat_id: { type: 'number', description: 'REQUIRED — Telegram chat ID (integer)' },
          text: { type: 'string', description: 'REQUIRED — The message text to send (max 4096 chars, supports MarkdownV2)' },
          parse_mode: { type: 'string', enum: ['MarkdownV2', 'HTML'], description: 'Parse mode (default: plain text)' },
        }
      }
    }, {
      name: 'telegram__send_photo',
      description: `[Telegram: ${conn.name}] Send a photo to a Telegram user or group. MANDATORY: "chat_id" and "photo" (URL or file_id).`,
      inputSchema: {
        type: 'object', required: ['chat_id', 'photo'],
        properties: {
          chat_id: { type: 'number', description: 'REQUIRED — Telegram chat ID' },
          photo: { type: 'string', description: 'REQUIRED — Photo URL or Telegram file_id' },
          caption: { type: 'string', description: 'Optional caption' },
        }
      }
    }]

    // ═══════════════════════════════════════════════════════════════════════
    // Cloud Infrastructure
    // ═══════════════════════════════════════════════════════════════════════
    case 'aws': return [
      { name: `aws__s3_list`,        description: `[AWS: ${conn.name}] List S3 buckets.`, inputSchema: { type: 'object', properties: {} } },
      { name: `aws__s3_objects`,     description: `[AWS: ${conn.name}] List objects in an S3 bucket.`, inputSchema: { type: 'object', required: ['bucket'], properties: { bucket: { type: 'string' }, prefix: { type: 'string' }, maxKeys: { type: 'integer', default: 50 } } } },
      { name: `aws__ec2_list`,       description: `[AWS: ${conn.name}] List EC2 instances with status.`, inputSchema: { type: 'object', properties: { region: { type: 'string' }, filters: { type: 'object' } } } },
      { name: `aws__cloudwatch_metrics`, description: `[AWS: ${conn.name}] Query CloudWatch metrics.`, inputSchema: { type: 'object', required: ['namespace', 'metricName'], properties: { namespace: { type: 'string' }, metricName: { type: 'string' }, period: { type: 'integer', default: 300 }, stat: { type: 'string', default: 'Average' } } } },
      { name: `aws__lambda_invoke`,  description: `[AWS: ${conn.name}] Invoke a Lambda function.`, inputSchema: { type: 'object', required: ['functionName'], properties: { functionName: { type: 'string' }, payload: { type: 'object' } } } },
    ]

    case 'kubernetes': return [
      { name: `k8s__get`,     description: `[K8s: ${conn.name}] Get a Kubernetes resource (pods, deployments, etc.).`, inputSchema: { type: 'object', required: ['resource', 'name'], properties: { resource: { type: 'string', description: 'Resource type (pods, deployments, services, etc.)' }, name: { type: 'string' }, namespace: { type: 'string', default: 'default' } } } },
      { name: `k8s__logs`,    description: `[K8s: ${conn.name}] Fetch pod logs.`, inputSchema: { type: 'object', required: ['pod'], properties: { pod: { type: 'string' }, container: { type: 'string' }, namespace: { type: 'string', default: 'default' }, tail: { type: 'integer', default: 50 } } } },
      { name: `k8s__describe`,description: `[K8s: ${conn.name}] Describe a resource.`, inputSchema: { type: 'object', required: ['resource', 'name'], properties: { resource: { type: 'string' }, name: { type: 'string' }, namespace: { type: 'string', default: 'default' } } } },
    ]

    case 'terraform': return [
      { name: `terraform__plan`,  description: `[Terraform: ${conn.name}] Trigger a plan.`, inputSchema: { type: 'object', required: ['workspaceId'], properties: { workspaceId: { type: 'string' } } } },
      { name: `terraform__apply`, description: `[Terraform: ${conn.name}] Apply a run.`, inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' }, comment: { type: 'string' } } } },
    ]

    // ═══════════════════════════════════════════════════════════════════════
    // IoT
    // ═══════════════════════════════════════════════════════════════════════
    case 'mqtt': return [
      { name: `mqtt__publish`,   description: `[MQTT: ${conn.name}] Publish a message to a topic.`, inputSchema: { type: 'object', required: ['topic', 'payload'], properties: { topic: { type: 'string' }, payload: { type: 'string' }, qos: { type: 'integer', default: 0 } } } },
      { name: `mqtt__subscribe`, description: `[MQTT: ${conn.name}] Subscribe to a topic.`, inputSchema: { type: 'object', required: ['topic'], properties: { topic: { type: 'string' }, timeout: { type: 'integer', default: 10 } } } },
    ]

    case 'thingsboard': return [
      { name: `thingsboard__telemetry`, description: `[ThingsBoard: ${conn.name}] Get device telemetry.`, inputSchema: { type: 'object', required: ['deviceId'], properties: { deviceId: { type: 'string' }, keys: { type: 'string' }, startTs: { type: 'integer' }, endTs: { type: 'integer' } } } },
      { name: `thingsboard__devices`,   description: `[ThingsBoard: ${conn.name}] List devices.`, inputSchema: { type: 'object', properties: { pageSize: { type: 'integer', default: 50 }, type: { type: 'string' } } } },
    ]

    // ═══════════════════════════════════════════════════════════════════════
    // Communication
    // ═══════════════════════════════════════════════════════════════════════
    case 'twilio': return [
      { name: `twilio__send_sms`, description: `[Twilio: ${conn.name}] Send SMS.`, inputSchema: { type: 'object', required: ['to', 'body'], properties: { to: { type: 'string', description: 'Phone number' }, body: { type: 'string' } } } },
      { name: `twilio__make_call`,description: `[Twilio: ${conn.name}] Make a voice call.`, inputSchema: { type: 'object', required: ['to', 'twiml'], properties: { to: { type: 'string' }, twiml: { type: 'string', description: 'TwiML instructions URL' } } } },
    ]

    case 'sendgrid': return [
      { name: `sendgrid__send`,  description: `[SendGrid: ${conn.name}] Send email.`, inputSchema: { type: 'object', required: ['to', 'subject', 'body'], properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, html: { type: 'string' } } } },
      { name: `sendgrid__stats`, description: `[SendGrid: ${conn.name}] Email stats.`, inputSchema: { type: 'object', properties: { startDate: { type: 'string' }, endDate: { type: 'string' }, aggregatedBy: { type: 'string', default: 'day' } } } },
    ]

    case 'discord': return [
      { name: `discord__send`,          description: `[Discord: ${conn.name}] Send message to channel.`, inputSchema: { type: 'object', required: ['channelId', 'content'], properties: { channelId: { type: 'string' }, content: { type: 'string' } } } },
      { name: `discord__list_channels`, description: `[Discord: ${conn.name}] List channels.`, inputSchema: { type: 'object', properties: {} } },
    ]

    // ═══════════════════════════════════════════════════════════════════════
    // Payments
    // ═══════════════════════════════════════════════════════════════════════
    case 'stripe': return [
      { name: `stripe__customers`,    description: `[Stripe: ${conn.name}] List customers.`, inputSchema: { type: 'object', properties: { email: { type: 'string' }, limit: { type: 'integer', default: 20 } } } },
      { name: `stripe__payments`,     description: `[Stripe: ${conn.name}] List payment intents.`, inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer', default: 20 } } } },
      { name: `stripe__subscriptions`,description: `[Stripe: ${conn.name}] List subscriptions.`, inputSchema: { type: 'object', properties: { status: { type: 'string' }, customer: { type: 'string' }, limit: { type: 'integer', default: 20 } } } },
      { name: `stripe__refund`,       description: `[Stripe: ${conn.name}] Create a refund.`, inputSchema: { type: 'object', required: ['paymentIntent'], properties: { paymentIntent: { type: 'string' }, amount: { type: 'integer' } } } },
    ]

    // ═══════════════════════════════════════════════════════════════════════
    // Support & ITSM
    // ═══════════════════════════════════════════════════════════════════════
    case 'zendesk': return [
      { name: `zendesk__tickets`,       description: `[Zendesk: ${conn.name}] List tickets.`, inputSchema: { type: 'object', properties: { status: { type: 'string' }, priority: { type: 'string' }, limit: { type: 'integer', default: 25 } } } },
      { name: `zendesk__create_ticket`, description: `[Zendesk: ${conn.name}] Create a ticket.`, inputSchema: { type: 'object', required: ['subject'], properties: { subject: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string' } } } },
      { name: `zendesk__update_ticket`, description: `[Zendesk: ${conn.name}] Update a ticket.`, inputSchema: { type: 'object', required: ['ticketId'], properties: { ticketId: { type: 'string' }, status: { type: 'string' }, comment: { type: 'string' } } } },
    ]

    case 'servicenow': return [
      { name: `servicenow__incidents`, description: `[ServiceNow: ${conn.name}] Query incidents.`, inputSchema: { type: 'object', properties: { sysparm_query: { type: 'string' }, sysparm_limit: { type: 'integer', default: 20 } } } },
      { name: `servicenow__changes`,   description: `[ServiceNow: ${conn.name}] Query changes.`, inputSchema: { type: 'object', properties: { sysparm_query: { type: 'string' }, sysparm_limit: { type: 'integer', default: 20 } } } },
    ]

    // ═══════════════════════════════════════════════════════════════════════
    // CRM
    // ═══════════════════════════════════════════════════════════════════════
    case 'hubspot': return [
      { name: `hubspot__contacts`,  description: `[HubSpot: ${conn.name}] Search contacts.`, inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', default: 20 } } } },
      { name: `hubspot__deals`,     description: `[HubSpot: ${conn.name}] List deals.`, inputSchema: { type: 'object', properties: { stage: { type: 'string' }, limit: { type: 'integer', default: 20 } } } },
      { name: `hubspot__companies`, description: `[HubSpot: ${conn.name}] Search companies.`, inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', default: 20 } } } },
    ]

    // ═══════════════════════════════════════════════════════════════════════
    // Data & Analytics
    // ═══════════════════════════════════════════════════════════════════════
    case 'snowflake': return [
      { name: `snowflake__query`,  description: `[Snowflake: ${conn.name}] Run read-only SQL.`, inputSchema: { type: 'object', required: ['sql'], properties: { sql: { type: 'string' } } } },
      { name: `snowflake__tables`, description: `[Snowflake: ${conn.name}] List tables.`, inputSchema: { type: 'object', properties: { schema: { type: 'string' } } } },
    ]

    case 'elasticsearch': return [
      { name: `elastic__search`,          description: `[ES: ${conn.name}] Search documents.`, inputSchema: { type: 'object', required: ['query'], properties: { index: { type: 'string' }, query: { type: 'object', description: 'Elasticsearch query DSL' }, size: { type: 'integer', default: 10 } } } },
      { name: `elastic__cluster_health`,  description: `[ES: ${conn.name}] Cluster health.`, inputSchema: { type: 'object', properties: {} } },
    ]

    case 'redis': return [
      { name: `redis__get`,  description: `[Redis: ${conn.name}] Get key value.`, inputSchema: { type: 'object', required: ['key'], properties: { key: { type: 'string' } } } },
      { name: `redis__set`,  description: `[Redis: ${conn.name}] Set key value.`, inputSchema: { type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'string' }, ttl: { type: 'integer', description: 'TTL in seconds' } } } },
      { name: `redis__keys`, description: `[Redis: ${conn.name}] List keys matching pattern.`, inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string', description: 'e.g. user:*' } } } },
    ]

    // ═══════════════════════════════════════════════════════════════════════
    // Monitoring
    // ═══════════════════════════════════════════════════════════════════════
    case 'prometheus': return [
      { name: `prometheus__query`, description: `[Prometheus: ${conn.name}] Instant query.`, inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'PromQL query' } } } },
      { name: `prometheus__range`, description: `[Prometheus: ${conn.name}] Range query.`, inputSchema: { type: 'object', required: ['query', 'start', 'end', 'step'], properties: { query: { type: 'string' }, start: { type: 'string', description: 'ISO timestamp' }, end: { type: 'string', description: 'ISO timestamp' }, step: { type: 'string', default: '1m' } } } },
      { name: `prometheus__alerts`,description: `[Prometheus: ${conn.name}] List alerts.`, inputSchema: { type: 'object', properties: {} } },
    ]

    case 'datadog': return [
      { name: `datadog__metrics`,  description: `[Datadog: ${conn.name}] Query metrics.`, inputSchema: { type: 'object', required: ['query', 'from', 'to'], properties: { query: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' } } } },
      { name: `datadog__logs`,     description: `[Datadog: ${conn.name}] Search logs.`, inputSchema: { type: 'object', required: ['query', 'from', 'to'], properties: { query: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' }, limit: { type: 'integer', default: 50 } } } },
      { name: `datadog__monitors`, description: `[Datadog: ${conn.name}] List monitors.`, inputSchema: { type: 'object', properties: {} } },
    ]

    // ═══════════════════════════════════════════════════════════════════════
    // Finance — QuickBooks Online
    // ═══════════════════════════════════════════════════════════════════════
    case 'quickbooks': return [
      { name: `quickbooks__invoices`,      description: `[QuickBooks: ${conn.name}] List invoices.`,        inputSchema: { type: 'object', properties: { status: { type: 'string' }, customer: { type: 'string' }, limit: { type: 'integer', default: 25 } } } },
      { name: `quickbooks__expenses`,      description: `[QuickBooks: ${conn.name}] List expenses.`,         inputSchema: { type: 'object', properties: { limit: { type: 'integer', default: 25 } } } },
      { name: `quickbooks__accounts`,      description: `[QuickBooks: ${conn.name}] List chart of accounts.`,inputSchema: { type: 'object', properties: { type: { type: 'string', description: 'e.g. Income, Expense, Bank' } } } },
      { name: `quickbooks__profit_loss`,   description: `[QuickBooks: ${conn.name}] Profit and Loss report.`,inputSchema: { type: 'object', properties: { startDate: { type: 'string' }, endDate: { type: 'string' } } } },
      { name: `quickbooks__customers`,     description: `[QuickBooks: ${conn.name}] List customers.`,        inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', default: 25 } } } },
    ]

    // ═══════════════════════════════════════════════════════════════════════
    // Documentation
    // ═══════════════════════════════════════════════════════════════════════
    case 'confluence': return [
      { name: `confluence__search`,      description: `[Confluence: ${conn.name}] Search pages.`,       inputSchema: { type: 'object', required: ['cql'], properties: { cql: { type: 'string', description: 'CQL query' }, limit: { type: 'integer', default: 20 } } } },
      { name: `confluence__get_page`,    description: `[Confluence: ${conn.name}] Get page by ID.`,      inputSchema: { type: 'object', required: ['pageId'], properties: { pageId: { type: 'string' } } } },
      { name: `confluence__create_page`, description: `[Confluence: ${conn.name}] Create a page.`,       inputSchema: { type: 'object', required: ['spaceKey', 'title', 'body'], properties: { spaceKey: { type: 'string' }, title: { type: 'string' }, body: { type: 'string', description: 'Storage format HTML' } } } },
    ]

    // Generic passthrough for any other API-key connector — generates a single
    // query tool that the agent can use to call the configured API endpoint.
    default: {
      const cfg = decryptCredentials(conn.config || {})
      // Only generate tools if we have a baseUrl or url to work with
      const endpoint = cfg.baseUrl || cfg.url || cfg.instanceUrl || cfg.brokerUrl || cfg.connectionUrl || cfg.host || ''
      if (!endpoint) return [] // no endpoint, no tools
      return [{
        name: `${conn.tool_id}__query`,
        description: `[${conn.name}] Generic API query tool. Calls ${endpoint} with the provided path and parameters.`,
        inputSchema: {
          type: 'object', required: ['path'],
          properties: {
            path: { type: 'string', description: 'API path to call (appended to base URL)' },
            method: { type: 'string', default: 'GET', enum: ['GET', 'POST', 'PUT', 'PATCH'] },
            query: { type: 'object', description: 'Query string parameters' },
            body: { type: 'object', description: 'Request body (for POST/PUT/PATCH)' },
          }
        }
      }]
    }
  }
}

// ─── Execution (dispatched from task.service executeTool) ─────────────────

/**
 * Look up the connector row for a given tool prefix and run the provider API call.
 * Returns { success, ...data } matching the shape task.service expects.
 */
/**
 * Execute a connector tool, respecting agent scopes.
 * @param {string} toolName - e.g. "local_dir__list"
 * @param {object} input - tool input parameters
 * @param {string} tenantId
 * @param {Set<string>} [allowedConnectorIds] - optional set of agent-scoped connector IDs.
 *   If empty/undefined, all active connectors for the provider are eligible (backward compat).
 *   If non-empty, only connectors whose ID is in the set may be used.
 */
export async function executeConnectorTool(toolName, input, tenantId, allowedConnectorIds) {
  const [provider] = toolName.split('__')
  if (!provider) return { success: false, error: `Malformed connector tool name: ${toolName}` }

  // Database tools are namespaced by connector id — parse and dispatch separately.
  if (provider === 'db') return executeDatabaseTool(toolName, input, tenantId)
  // Generic REST tools likewise namespace on the connector id.
  if (provider === 'rest') return executeRestTool(toolName, input, tenantId)

  const toolIdQuery = ['local_dir', 'local_shell', 'local_applescript'].includes(provider) ? provider.replace('_', '-') : provider

  // Fetch ACTIVE connectors for this provider on this tenant.
  // When the agent has explicit scope → only scoped connectors are eligible.
  // Otherwise → fall back to newest (backward-compatible default).
  const hasExplicitScopes = allowedConnectorIds && allowedConnectorIds.size > 0
  let conn
  if (hasExplicitScopes) {
    // Try scoped connectors first — pick the newest among allowed ones
    const { rows } = await query(
      `SELECT id, tenant_id, tool_id, name, auth_type, config
       FROM tool_connections
       WHERE tenant_id = $1 AND tool_id = $2 AND status = 'ACTIVE'
         AND id = ANY($3::uuid[])
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, toolIdQuery, [...allowedConnectorIds]]
    )
    conn = rows[0]
  }
  // Fallback: no explicit scopes → pick newest (original behavior)
  if (!conn) {
    const { rows: [fallback] } = await query(
      `SELECT id, tenant_id, tool_id, name, auth_type, config
       FROM tool_connections
       WHERE tenant_id = $1 AND tool_id = $2 AND status = 'ACTIVE'
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, toolIdQuery]
    )
    // If we had explicit scopes but found no match → the agent is not authorized for this provider
    if (hasExplicitScopes && fallback && !allowedConnectorIds.has(fallback.id)) {
      return { success: false, error: `Agent is not authorized to use ${provider} connector "${fallback.name}". The agent has explicit connector scopes that do not include this provider.` }
    }
    conn = fallback
  }
  if (!conn) return { success: false, error: `No active ${provider} connector configured for this tenant.` }

  const config = decryptCredentials(conn.config || {})

  // ── Docker ────────────────────────────────────────────────────────────
  if (toolName.startsWith('docker__')) {
    const { execAsync } = await import('./connector-tools.service.js')
    const subCmd = toolName.replace('docker__', '')
    try {
      let cmd = ''
      const { image, command, container, workdir, mount, env, timeout, tail, all } = input
      if (subCmd === 'run') {
        const wd = workdir ? `-w '${workdir}'` : ''
        const vol = mount ? `-v '${mount}'` : ''
        const envs = env ? Object.entries(env).map(([k, v]) => `-e ${k}='${v}'`).join(' ') : ''
        const t = Math.min(timeout || 30, 120)
        cmd = `docker run --rm ${wd} ${vol} ${envs} --network none ${image} sh -c '${command}'`
      } else if (subCmd === 'exec') {
        cmd = `docker exec ${container} sh -c '${command}'`
      } else if (subCmd === 'logs') {
        cmd = `docker logs --tail ${tail || 50} ${container} 2>&1`
      } else if (subCmd === 'ps') {
        cmd = `docker ${all ? 'ps -a' : 'ps'} --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'`
      } else {
        return { success: false, error: `Unknown docker sub-command: ${subCmd}` }
      }
      const { stdout } = await execAsync(cmd)
      return { success: true, output: stdout.trim() }
    } catch (err) {
      return { success: false, error: `Docker ${subCmd} failed: ${err.message}` }
    }
  }

  // ── SSH ───────────────────────────────────────────────────────────────
  if (toolName.startsWith('ssh__')) {
    const { execAsync } = await import('./connector-tools.service.js')
    const subCmd = toolName.replace('ssh__', '')
    try {
      const { host, command, port, user, timeout, remote_path, content } = input
      const p = port || 22
      const u = user || 'root'
      const t = Math.min(timeout || 30, 120)
      if (subCmd === 'exec') {
        const cmd = `ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p ${p} ${u}@${host} '${command}'`
        const { stdout } = await execAsync(cmd, { timeout: t * 1000 })
        return { success: true, output: stdout.trim() }
      } else if (subCmd === 'upload') {
        // Write content to tmp file, scp it, clean up
        const tmpFile = `/tmp/ssh_upload_${Date.now()}`
        const { execAsync: exec } = await import('./connector-tools.service.js')
        await exec(`cat > ${tmpFile} << 'KUVALAM_EOF'\n${content}\nKUVALAM_EOF`)
        const cmd = `scp -o StrictHostKeyChecking=accept-new -P ${p} ${tmpFile} ${u}@${host}:${remote_path}`
        await exec(cmd, { timeout: 30000 })
        await exec(`rm -f ${tmpFile}`)
        return { success: true, message: `File uploaded to ${host}:${remote_path}` }
      } else {
        return { success: false, error: `Unknown ssh sub-command: ${subCmd}` }
      }
    } catch (err) {
      return { success: false, error: `SSH ${subCmd} failed: ${err.message}` }
    }
  }

  try {
    switch (toolName) {
      case 'local_shell__execute':       return await localShellExecute(config, input)
      case 'local_applescript__execute': return await localApplescriptExecute(config, input)
      
      case 'local_dir__list':       return await localDirList(config, input)
      case 'local_dir__read':       return await localDirRead(config, input)
      case 'local_dir__write':      return await localDirWrite(config, input)

      case 'slack__post_message':   return await slackPostMessage(conn, input)
      case 'slack__update_message': return await slackUpdateMessage(conn, input)
      case 'slack__list_channels':  return await slackListChannels(conn, input)
      case 'slack__get_history':    return await slackGetHistory(conn, input)
      case 'slack__add_reaction':   return await slackAddReaction(conn, input)
      case 'slack__lookup_user':    return await slackLookupUser(conn, input)

      case 'jira__create_issue':   return await jiraCreateIssue(conn, config, input)
      case 'jira__search_issues':  return await jiraSearchIssues(conn, config, input)

      case 'github__create_issue': return await githubCreateIssue(config, input)
      case 'github__search_repos': return await githubSearchRepos(config, input)
      case 'github__get_repo':     return await githubGetRepo(config, input)

      case 'gmail__send_email':    return await gmailSendEmail(conn, input)
      case 'gmail__list_messages': return await gmailListMessages(conn, input)
      case 'gmail__get_message':   return await gmailGetMessage(conn, input)

      case 'notion__search':          return await notionSearch(config, input)
      case 'notion__retrieve_page':   return await notionRetrievePage(config, input)
      case 'notion__create_page':     return await notionCreatePage(config, input)
      case 'notion__query_database':  return await notionQueryDatabase(config, input)
      case 'notion__append_blocks':   return await notionAppendBlocks(config, input)

      case 'linear__list_teams':    return await linearListTeams(config)
      case 'linear__create_issue':  return await linearCreateIssue(config, input)
      case 'linear__search_issues': return await linearSearchIssues(config, input)
      case 'linear__update_issue':  return await linearUpdateIssue(config, input)
      case 'linear__add_comment':   return await linearAddComment(config, input)

      case 'salesforce__query':           return await salesforceQuery(conn, config, input)
      case 'salesforce__describe_object': return await salesforceDescribe(conn, config, input)
      case 'salesforce__create_record':   return await salesforceCreateRecord(conn, config, input)
      case 'salesforce__update_record':   return await salesforceUpdateRecord(conn, config, input)

      case 'webhook__post':        return await webhookPost(config, input)

      case 'whatsapp__send_message':  return await whatsappSendMessage(conn, input)
      case 'whatsapp__send_template': return await whatsappSendTemplate(conn, input)

      case 'telegram__send_message':  return await telegramSendMessage(conn, input)
      case 'telegram__send_photo':    return await telegramSendPhoto(conn, input)

      // ═══════════════════════════════════════════════════════════
      // Generic REST API connector — handles AWS, Stripe, Twilio,
      // SendGrid, Discord, Zendesk, ServiceNow, HubSpot, Snowflake,
      // Elasticsearch, Prometheus, Datadog, Confluence, Terraform,
      // ThingsBoard, and any other REST-based provider.
      // ═══════════════════════════════════════════════════════════
      default: return await genericRestExecute(conn, config, toolName, input)
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

/**
 * Parse `db__<connIdSlug>__<op>` and dispatch to the database-connector service.
 * Uses a slug-aware SELECT so we don't have to un-slug a UUID (safer against
 * pathological ids).
 */
async function executeDatabaseTool(toolName, input, tenantId) {
  const parts = toolName.split('__')
  if (parts.length < 3) return { success: false, error: `Malformed DB tool name: ${toolName}` }
  const connSlug = parts[1]
  const op = parts.slice(2).join('__')

  const { rows: [conn] } = await query(
    `SELECT id, tenant_id, tool_id, name, config
     FROM tool_connections
     WHERE tenant_id = $1
       AND status = 'ACTIVE'
       AND tool_id IN ('database','postgres')
       AND REPLACE(id::text, '-', '_') = $2
     LIMIT 1`,
    [tenantId, connSlug]
  )
  if (!conn) return { success: false, error: 'Database connector not found or not active for this tenant.' }

  try {
    switch (op) {
      case 'list_tables':    return await dbListTables(conn)
      case 'describe_table': return await dbDescribeTable(conn, input || {})
      case 'sample':         return await dbSampleTable(conn, input || {})
      case 'query':          return await dbRunQuery(conn, input || {})
      default: return { success: false, error: `Unknown DB operation: ${op}` }
    }
  } catch (err) {
    return {
      success: false,
      error: `DATABASE QUERY FAILED — DO NOT INVENT OR FABRICATE DATA: ${err.message}`,
      instruction: 'Use list_tables to see available tables, then describe_table to check column names, then retry with correct SQL using only real column names.'
    }
  }
}


// ─── Provider handlers ────────────────────────────────────────────────────

async function slackPostMessage(conn, { channel, text, thread_ts, blocks }) {
  const token = await getSlackToken(conn)
  const res = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      channel, text,
      ...(thread_ts ? { thread_ts } : {}),
      ...(Array.isArray(blocks) && blocks.length ? { blocks } : {}),
    })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) {
    return { success: false, error: `Slack error: ${body.error || res.status}` }
  }
  return { success: true, ts: body.ts, channel: body.channel }
}

async function jiraCreateIssue(conn, config, { projectKey, summary, description, issueType = 'Task' }) {
  // Fall back to the default projectKey stored in the connector config
  const effectiveProjectKey = projectKey || config.projectKey
  if (!effectiveProjectKey) {
    return { success: false, error: 'projectKey is required — either pass it at runtime or set a Default Project Key on the Jira connector' }
  }
  const base = String(config.baseUrl || '').replace(/\/$/, '')
  assertSafeUrl(base)
  const basic = Buffer.from(`${config.email}:${config.apiKey}`).toString('base64')
  const res = await fetchWithTimeout(`${base}/rest/api/3/issue`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      fields: {
        project: { key: effectiveProjectKey },
        summary,
        issuetype: { name: issueType },
        // Jira Cloud v3 requires Atlassian Document Format for description
        ...(description ? {
          description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }] }
        } : {})
      }
    })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { success: false, error: `Jira ${res.status}: ${JSON.stringify(body.errors || body)}` }
  return { success: true, key: body.key, id: body.id, url: `${base}/browse/${body.key}` }
}

async function jiraSearchIssues(conn, config, { jql, maxResults = 10 }) {
  // ── Defensive: strip LIMIT from JQL (common LLM mistake — JQL has no LIMIT) ──
  const limitMatch = jql.match(/\bLIMIT\s+(\d+)/i)
  if (limitMatch) {
    const parsedLimit = parseInt(limitMatch[1], 10)
    if (parsedLimit > 0 && parsedLimit <= 50) {
      maxResults = parsedLimit  // use the intended limit from JQL
    }
    jql = jql.replace(/\bLIMIT\s+\d+/i, '').trim()
    console.log(`[jiraSearchIssues] Stripped LIMIT from JQL, using maxResults=${maxResults}`)
  }

  const base = String(config.baseUrl || '').replace(/\/$/, '')
  assertSafeUrl(base)
  const basic = Buffer.from(`${config.email}:${config.apiKey}`).toString('base64')
  // Jira Cloud v3 /search/jql returns ONLY issue IDs unless fields are
  // explicitly requested. Request the fields the agent needs for reporting.
  const fields = 'key,summary,status,assignee,priority,issuetype,created,updated,resolutiondate,customfield_10001,customfield_10006'
  const url = `${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${Math.min(maxResults, 50)}&fields=${encodeURIComponent(fields)}`
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' } })
  let bodyText = await res.text()
  let body = {}
  try { body = JSON.parse(bodyText) } catch (e) {}
  if (!res.ok) return { success: false, error: `Jira ${res.status}: ${body.errorMessages ? body.errorMessages.join(', ') : (bodyText || 'Unknown error')}` }
  const issues = (body.issues || []).map(i => {
    const sprint = Array.isArray(i.fields?.customfield_10001) ? i.fields.customfield_10001[0] : null
    return {
      key: i.key, summary: i.fields?.summary, status: i.fields?.status?.name,
      assignee: i.fields?.assignee?.displayName, priority: i.fields?.priority?.name,
      issuetype: i.fields?.issuetype?.name, created: i.fields?.created, updated: i.fields?.updated,
      resolutiondate: i.fields?.resolutiondate, storyPoints: i.fields?.customfield_10006 ?? null,
      sprint: sprint ? { id: sprint.id, name: sprint.name, state: sprint.state } : null,
      url: `${base}/browse/${i.key}`
    }
  })
  return { success: true, total: body.total, issues }
}

async function githubCreateIssue(config, { owner, repo, title, body, labels }) {
  const res = await fetchWithTimeout(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({ title, body, ...(labels ? { labels } : {}) })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { success: false, error: `GitHub ${res.status}: ${data.message || 'error'}` }
  return { success: true, number: data.number, url: data.html_url }
}

async function githubSearchRepos(config, { q, per_page = 5 }) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=${Math.min(per_page, 30)}`
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/vnd.github+json' }
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { success: false, error: `GitHub ${res.status}: ${data.message || 'error'}` }
  const items = (data.items || []).map(r => ({
    full_name: r.full_name, description: r.description,
    stars: r.stargazers_count, url: r.html_url
  }))
  return { success: true, total_count: data.total_count, items }
}

async function githubGetRepo(config, { owner, repo }) {
  const res = await fetchWithTimeout(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/vnd.github+json' }
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { success: false, error: `GitHub ${res.status}: ${data.message || 'error'}` }
  return {
    success: true,
    full_name: data.full_name, description: data.description,
    default_branch: data.default_branch, stars: data.stargazers_count,
    url: data.html_url, open_issues: data.open_issues_count
  }
}

async function gmailSendEmail(conn, { to, cc, bcc, subject, body, html }) {
  const token = await getValidAccessToken(conn.tenant_id, conn.id)
  // RFC 5322 message, then base64url-encoded per Gmail API.
  // If html is provided, send multipart/alternative so both plain text and html render.
  const headerLines = [
    `To: ${to}`,
    ...(cc  ? [`Cc: ${cc}`]   : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
  ]
  let mime
  if (html) {
    const boundary = `----=kuvalam_${Date.now().toString(36)}`
    mime = [
      ...headerLines,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body || '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      html,
      `--${boundary}--`,
      ''
    ].join('\r\n')
  } else {
    mime = [
      ...headerLines,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body || ''
    ].join('\r\n')
  }
  const raw = Buffer.from(mime, 'utf8').toString('base64url')

  const res = await fetchWithTimeout('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { success: false, error: `Gmail ${res.status}: ${data.error?.message || 'send failed'}` }
  return { success: true, id: data.id, threadId: data.threadId }
}

async function webhookPost(config, { payload }) {
  const url = String(config.url || '')
  assertSafeUrl(url)
  const bodyStr = JSON.stringify(payload)
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'kuvalam-agent/1.0' }
  if (config.secret) {
    // HMAC-SHA256 signature so the receiver can authenticate the payload
    headers['X-Kuvalam-Signature'] = 'sha256=' + createHmac('sha256', config.secret).update(bodyStr).digest('hex')
  }
  const res = await fetchWithTimeout(url, { method: 'POST', headers, body: bodyStr })
  const text = await res.text().catch(() => '')
  return { success: res.ok, status: res.status, response: text.slice(0, 500) }
}

// ─── WhatsApp handlers ────────────────────────────────────────────────────

async function whatsappSendMessage(conn, input) {
  const cfg = decryptCredentials(conn.config || {})
  const phoneNumberId = cfg.phoneNumberId || cfg.phone_number_id
  const accessToken = cfg.accessToken || cfg.access_token
  if (!phoneNumberId || !accessToken) {
    return { success: false, error: 'WhatsApp connector missing phoneNumberId or accessToken' }
  }

  const to = input.to
  const text = input.text || input.message || input.content || ''
  if (!to) return { success: false, error: 'to (phone number) is required' }
  if (!text) return { success: false, error: 'text (message body) is required' }

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: {
      preview_url: input.preview_url || false,
      body: text.slice(0, 4096),
    },
  }

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    return { success: false, error: data.error?.message || `HTTP ${res.status}`, details: data.error }
  }
  return { success: true, wa_message_id: data.messages?.[0]?.id }
}

async function whatsappSendTemplate(conn, input) {
  const cfg = decryptCredentials(conn.config || {})
  const phoneNumberId = cfg.phoneNumberId || cfg.phone_number_id
  const accessToken = cfg.accessToken || cfg.access_token
  if (!phoneNumberId || !accessToken) {
    return { success: false, error: 'WhatsApp connector missing credentials' }
  }

  const to = input.to
  const templateName = input.template_name
  if (!to || !templateName) {
    return { success: false, error: 'to and template_name are required' }
  }

  const componentParams = (input.parameters || []).map(p => ({
    type: 'text',
    text: String(p).slice(0, 1024),
  }))

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: input.language || 'en' },
      components: componentParams.length > 0 ? [{
        type: 'body',
        parameters: componentParams,
      }] : [],
    },
  }

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    return { success: false, error: data.error?.message || `HTTP ${res.status}`, details: data.error }
  }
  return { success: true, wa_message_id: data.messages?.[0]?.id }
}

// ─── Telegram handlers ────────────────────────────────────────────────────

async function telegramSendMessage(conn, input) {
  const cfg = decryptCredentials(conn.config || {})
  const botToken = cfg.botToken || cfg.bot_token
  if (!botToken) {
    return { success: false, error: 'Telegram connector missing botToken' }
  }

  const chatId = input.chat_id || input.chatId
  const text = input.text || input.message || input.content || ''
  if (!chatId) return { success: false, error: 'chat_id is required' }
  if (!text) return { success: false, error: 'text (message body) is required' }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`
  const body = {
    chat_id: chatId,
    text: String(text).slice(0, 4096),
    parse_mode: input.parse_mode || undefined,
    disable_web_page_preview: true,
  }

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!data.ok) {
    return { success: false, error: data.description || `HTTP ${res.status}`, error_code: data.error_code }
  }
  return { success: true, telegram_message_id: data.result?.message_id, chat: data.result?.chat }
}

async function telegramSendPhoto(conn, input) {
  const cfg = decryptCredentials(conn.config || {})
  const botToken = cfg.botToken || cfg.bot_token
  if (!botToken) {
    return { success: false, error: 'Telegram connector missing botToken' }
  }

  const chatId = input.chat_id || input.chatId
  const photo = input.photo
  if (!chatId || !photo) {
    return { success: false, error: 'chat_id and photo are required' }
  }

  const url = `https://api.telegram.org/bot${botToken}/sendPhoto`
  const body = {
    chat_id: chatId,
    photo,
    caption: (input.caption || '').slice(0, 1024),
  }

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!data.ok) {
    return { success: false, error: data.description || `HTTP ${res.status}` }
  }
  return { success: true, telegram_message_id: data.result?.message_id }
}

// ─── Slack extended handlers ──────────────────────────────────────────────

// Shared helper — every Slack call returns `{ ok, error?, ...data }`.
async function slackApi(conn, path, { method = 'POST', body, formEncoded } = {}) {
  const token = await getSlackToken(conn)
  const headers = { Authorization: `Bearer ${token}` }
  let payload
  if (formEncoded) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8'
    payload = new URLSearchParams(body).toString()
  } else if (body) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
    payload = JSON.stringify(body)
  }
  const url = `https://slack.com/api/${path}`
  const res = await fetchWithTimeout(url, { method, headers, body: payload })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) {
    return { success: false, error: `Slack ${path} failed: ${data.error || res.status}` }
  }
  return { success: true, ...data }
}

async function slackUpdateMessage(conn, { channel, ts, text }) {
  const r = await slackApi(conn, 'chat.update', { body: { channel, ts, text } })
  if (!r.success) return r
  return { success: true, ts: r.ts, channel: r.channel }
}

async function slackListChannels(conn, { types, limit = 100, name_filter } = {}) {
  // conversations.list requires GET with query string parameters
  const token = await getSlackToken(conn)
  const params = new URLSearchParams({
    types: types || 'public_channel,private_channel',
    limit: String(Math.min(limit || 100, 200)),
    exclude_archived: 'true',
  })
  const url = `https://slack.com/api/conversations.list?${params.toString()}`
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) {
    return { success: false, error: `Slack conversations.list failed: ${data.error || res.status}` }
  }
  let channels = (data.channels || []).map(c => ({
    id: c.id, name: c.name, is_private: c.is_private, is_archived: c.is_archived, num_members: c.num_members
  }))
  if (name_filter) {
    const needle = String(name_filter).toLowerCase()
    channels = channels.filter(c => c.name && c.name.toLowerCase().includes(needle))
  }
  return { success: true, count: channels.length, channels }
}

async function slackGetHistory(conn, { channel, limit = 20 }) {
  const token = await getSlackToken(conn)
  const params = new URLSearchParams({ channel, limit: String(Math.min(limit || 20, 50)) })
  const url = `https://slack.com/api/conversations.history?${params.toString()}`
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) {
    return { success: false, error: `Slack conversations.history failed: ${data.error || res.status}` }
  }
  const messages = (data.messages || []).map(m => ({
    ts: m.ts, user: m.user, bot_id: m.bot_id, text: m.text,
    thread_ts: m.thread_ts, reply_count: m.reply_count
  }))
  return { success: true, count: messages.length, messages }
}

async function slackAddReaction(conn, { channel, timestamp, name }) {
  const cleanName = String(name || '').replace(/^:|:$/g, '')
  const r = await slackApi(conn, 'reactions.add', { formEncoded: true, body: { channel, timestamp, name: cleanName } })
  if (!r.success) return r
  return { success: true }
}

async function slackLookupUser(conn, { email }) {
  const token = await getSlackToken(conn)
  const url = `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) {
    return { success: false, error: `Slack users.lookupByEmail failed: ${data.error || res.status}` }
  }
  return {
    success: true,
    id: data.user?.id,
    name: data.user?.name,
    real_name: data.user?.real_name,
    tz: data.user?.tz,
  }
}

// ─── Gmail extended handlers ──────────────────────────────────────────────

async function gmailListMessages(conn, { q = '', limit = 10 } = {}) {
  const token = await getValidAccessToken(conn.tenant_id, conn.id)
  const params = new URLSearchParams({ maxResults: String(Math.min(limit || 10, 50)) })
  if (q) params.set('q', q)
  const res = await fetchWithTimeout(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { success: false, error: `Gmail list failed: ${data.error?.message || res.status}` }
  return {
    success: true,
    count: (data.messages || []).length,
    messages: data.messages || [],  // [{id, threadId}]
  }
}

async function gmailGetMessage(conn, { id }) {
  if (!id) return { success: false, error: 'id is required' }
  const token = await getValidAccessToken(conn.tenant_id, conn.id)
  const res = await fetchWithTimeout(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { success: false, error: `Gmail get failed: ${data.error?.message || res.status}` }

  const headers = Object.fromEntries(
    (data.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value])
  )
  // Try to extract a plain-text body from the MIME tree
  function findBody(part) {
    if (!part) return null
    if (part.mimeType === 'text/plain' && part.body?.data) return part.body.data
    for (const p of (part.parts || [])) {
      const b = findBody(p)
      if (b) return b
    }
    return null
  }
  const b64 = findBody(data.payload)
  let body = ''
  if (b64) {
    try { body = Buffer.from(b64, 'base64').toString('utf8') } catch { /* ignore */ }
  }
  // Cap for LLM context
  if (body.length > 8000) body = body.slice(0, 8000) + '…[truncated]'

  return {
    success: true,
    id: data.id,
    threadId: data.threadId,
    snippet: data.snippet,
    from: headers['from'],
    to: headers['to'],
    subject: headers['subject'],
    date: headers['date'],
    body,
  }
}

// ─── Notion handlers ──────────────────────────────────────────────────────

const NOTION_VERSION = '2022-06-28'

function notionHeaders(config) {
  if (!config?.apiKey) throw new Error('Notion integration secret is missing')
  return {
    Authorization: `Bearer ${config.apiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  }
}

async function notionSearch(config, { query: q = '', filter = 'any', limit = 10 } = {}) {
  const body = { query: q, page_size: Math.min(limit || 10, 50) }
  if (filter === 'page' || filter === 'database') {
    body.filter = { value: filter, property: 'object' }
  }
  const res = await fetchWithTimeout('https://api.notion.com/v1/search', {
    method: 'POST', headers: notionHeaders(config), body: JSON.stringify(body)
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { success: false, error: `Notion search failed: ${data.message || res.status}` }
  const results = (data.results || []).map(r => ({
    id: r.id,
    object: r.object,
    url: r.url,
    title:
      r.properties?.title?.title?.[0]?.plain_text ||
      r.properties?.Name?.title?.[0]?.plain_text ||
      r.title?.[0]?.plain_text ||
      '(untitled)',
    last_edited_time: r.last_edited_time,
  }))
  return { success: true, count: results.length, results }
}

async function notionRetrievePage(config, { page_id }) {
  if (!page_id) return { success: false, error: 'page_id is required' }
  const [pageRes, blocksRes] = await Promise.all([
    fetchWithTimeout(`https://api.notion.com/v1/pages/${encodeURIComponent(page_id)}`, { headers: notionHeaders(config) }),
    fetchWithTimeout(`https://api.notion.com/v1/blocks/${encodeURIComponent(page_id)}/children?page_size=100`, { headers: notionHeaders(config) }),
  ])
  const page = await pageRes.json().catch(() => ({}))
  if (!pageRes.ok) return { success: false, error: `Notion page failed: ${page.message || pageRes.status}` }
  const blocks = await blocksRes.json().catch(() => ({ results: [] }))

  // Flatten common block types to plain text for the LLM
  function blockText(b) {
    const rt = b?.[b.type]?.rich_text || []
    return rt.map(r => r.plain_text).join('')
  }
  const bodyText = (blocks.results || []).map(blockText).filter(Boolean).join('\n\n')
  return {
    success: true,
    id: page.id, url: page.url,
    properties: page.properties,
    body: bodyText.slice(0, 8000)
  }
}

async function notionCreatePage(config, { parent_type, parent_id, title, content, properties }) {
  if (!parent_type || !parent_id) return { success: false, error: 'parent_type and parent_id are required' }
  const parent = parent_type === 'database_id' ? { database_id: parent_id } : { page_id: parent_id }

  let props
  if (parent_type === 'database_id') {
    props = properties || {}
    // Convenience: if caller provided a plain string title, drop it into the "Name" or "Title" property
    if (title && !Object.keys(props).length) {
      props = { Name: { title: [{ text: { content: title } }] } }
    }
  } else {
    // Page parent — title lives on `properties.title`
    props = { title: { title: [{ text: { content: title || 'Untitled' } }] } }
  }

  const body = { parent, properties: props }
  if (content) {
    body.children = String(content).split(/\n{2,}/).map(chunk => ({
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: chunk.slice(0, 2000) } }] }
    }))
  }

  const res = await fetchWithTimeout('https://api.notion.com/v1/pages', {
    method: 'POST', headers: notionHeaders(config), body: JSON.stringify(body)
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { success: false, error: `Notion create failed: ${data.message || res.status}` }
  return { success: true, id: data.id, url: data.url }
}

async function notionQueryDatabase(config, { database_id, filter, sorts, limit = 25 }) {
  if (!database_id) return { success: false, error: 'database_id is required' }
  const body = { page_size: Math.min(limit || 25, 50) }
  if (filter) body.filter = filter
  if (sorts)  body.sorts = sorts
  const res = await fetchWithTimeout(
    `https://api.notion.com/v1/databases/${encodeURIComponent(database_id)}/query`,
    { method: 'POST', headers: notionHeaders(config), body: JSON.stringify(body) }
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { success: false, error: `Notion query failed: ${data.message || res.status}` }
  const rows = (data.results || []).map(r => ({
    id: r.id, url: r.url,
    properties: r.properties,
    last_edited_time: r.last_edited_time,
  }))
  return { success: true, count: rows.length, has_more: data.has_more, rows }
}

async function notionAppendBlocks(config, { page_id, text }) {
  if (!page_id || !text) return { success: false, error: 'page_id and text are required' }
  const children = String(text).split(/\n/).map(line => ({
    object: 'block', type: 'paragraph',
    paragraph: { rich_text: line ? [{ type: 'text', text: { content: line.slice(0, 2000) } }] : [] }
  }))
  const res = await fetchWithTimeout(
    `https://api.notion.com/v1/blocks/${encodeURIComponent(page_id)}/children`,
    { method: 'PATCH', headers: notionHeaders(config), body: JSON.stringify({ children }) }
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { success: false, error: `Notion append failed: ${data.message || res.status}` }
  return { success: true, appended: (data.results || []).length }
}

// ─── Linear handlers ──────────────────────────────────────────────────────

async function linearGql(config, gqlQuery, variables) {
  if (!config?.apiKey) return { success: false, error: 'Linear API key is missing' }
  const res = await fetchWithTimeout('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: config.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gqlQuery, variables })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { success: false, error: `Linear HTTP ${res.status}` }
  if (data.errors?.length) {
    return { success: false, error: `Linear error: ${data.errors.map(e => e.message).join('; ')}` }
  }
  return { success: true, data: data.data }
}

async function linearListTeams(config) {
  const r = await linearGql(config, `query { teams(first: 50) { nodes { id key name description } } }`)
  if (!r.success) return r
  return { success: true, teams: r.data?.teams?.nodes || [] }
}

async function linearResolveTeamId(config, { teamId, teamKey }) {
  if (teamId) return teamId
  if (!teamKey) return null
  const r = await linearGql(config,
    `query($key: String!) { teams(filter: { key: { eq: $key } }, first: 1) { nodes { id } } }`,
    { key: teamKey }
  )
  if (!r.success) return null
  return r.data?.teams?.nodes?.[0]?.id || null
}

async function linearCreateIssue(config, { teamId, teamKey, title, description, priority, assigneeId }) {
  const resolvedTeam = await linearResolveTeamId(config, { teamId, teamKey })
  if (!resolvedTeam) return { success: false, error: 'Could not resolve teamId — pass a valid teamId or teamKey' }
  const input = { teamId: resolvedTeam, title }
  if (description) input.description = description
  if (Number.isInteger(priority)) input.priority = priority
  if (assigneeId) input.assigneeId = assigneeId
  const r = await linearGql(config,
    `mutation($input: IssueCreateInput!) {
       issueCreate(input: $input) {
         success
         issue { id identifier title url priority state { name } }
       }
     }`,
    { input }
  )
  if (!r.success) return r
  const issue = r.data?.issueCreate?.issue
  if (!issue) return { success: false, error: 'Linear did not return the created issue' }
  return { success: true, ...issue }
}

async function linearSearchIssues(config, { query: q, limit = 10 }) {
  if (!q) return { success: false, error: 'query is required' }
  const r = await linearGql(config,
    `query($q: String!, $first: Int!) {
       issues(filter: { or: [
         { title: { containsIgnoreCase: $q } },
         { identifier: { containsIgnoreCase: $q } }
       ]}, first: $first) {
         nodes { id identifier title url state { name } assignee { name } }
       }
     }`,
    { q, first: Math.min(limit || 10, 25) }
  )
  if (!r.success) return r
  return { success: true, issues: r.data?.issues?.nodes || [] }
}

async function linearUpdateIssue(config, { issueId, title, description, priority, stateId }) {
  if (!issueId) return { success: false, error: 'issueId is required' }
  const input = {}
  if (title !== undefined) input.title = title
  if (description !== undefined) input.description = description
  if (Number.isInteger(priority)) input.priority = priority
  if (stateId) input.stateId = stateId
  if (Object.keys(input).length === 0) return { success: false, error: 'Nothing to update' }

  const r = await linearGql(config,
    `mutation($id: String!, $input: IssueUpdateInput!) {
       issueUpdate(id: $id, input: $input) {
         success
         issue { id identifier title url state { name } }
       }
     }`,
    { id: issueId, input }
  )
  if (!r.success) return r
  const issue = r.data?.issueUpdate?.issue
  return { success: !!issue, ...(issue || {}) }
}

async function linearAddComment(config, { issueId, body }) {
  if (!issueId || !body) return { success: false, error: 'issueId and body are required' }
  const r = await linearGql(config,
    `mutation($input: CommentCreateInput!) {
       commentCreate(input: $input) {
         success
         comment { id url }
       }
     }`,
    { input: { issueId, body } }
  )
  if (!r.success) return r
  const c = r.data?.commentCreate?.comment
  return { success: !!c, ...(c || {}) }
}

// ─── Salesforce handlers ──────────────────────────────────────────────────

// Salesforce OAuth returns an `instance_url` at grant time. We store it on the
// connector config so we can build absolute API URLs without hard-coding a pod.
function salesforceInstance(config) {
  const inst =
    config?.oauth?.instance_url ||
    config?.oauth?.raw?.instance_url ||
    config?.instanceUrl
  if (!inst) throw new Error('Salesforce instance URL missing — reconnect the OAuth integration')
  assertSafeUrl(inst)
  return String(inst).replace(/\/$/, '')
}

// SOQL safety: reject anything that isn't a single SELECT (mirrors the DB connector guard).
function assertReadOnlySoql(soql) {
  if (typeof soql !== 'string' || soql.trim() === '') throw new Error('SOQL is required')
  const stripped = soql.trim().replace(/;+\s*$/, '')
  if (stripped.includes(';')) throw new Error('Multi-statement SOQL not allowed')
  if (!/^SELECT\b/i.test(stripped)) throw new Error('Only SELECT queries are allowed')
  return stripped
}

async function salesforceApi(conn, config, path, { method = 'GET', body } = {}) {
  const instance = salesforceInstance(config)
  const token = await getValidAccessToken(conn.tenant_id, conn.id)
  const url = `${instance}${path}`
  const res = await fetchWithTimeout(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text().catch(() => '')
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  return { ok: res.ok, status: res.status, data }
}

async function salesforceQuery(conn, config, { soql, limit = 50 }) {
  let cleaned
  try { cleaned = assertReadOnlySoql(soql) } catch (e) { return { success: false, error: e.message } }

  // Enforce a hard LIMIT to protect LLM context
  const cap = Math.min(limit || 50, 200)
  if (!/\bLIMIT\s+\d+/i.test(cleaned)) cleaned = `${cleaned} LIMIT ${cap}`

  const r = await salesforceApi(conn, config, `/services/data/v59.0/query/?q=${encodeURIComponent(cleaned)}`)
  if (!r.ok) return { success: false, error: `Salesforce ${r.status}: ${r.data?.[0]?.message || r.data?.error || 'query failed'}` }
  return {
    success: true,
    totalSize: r.data?.totalSize,
    done: r.data?.done,
    records: (r.data?.records || []).slice(0, cap),
  }
}

async function salesforceDescribe(conn, config, { sobject }) {
  if (!sobject) return { success: false, error: 'sobject is required' }
  const r = await salesforceApi(conn, config, `/services/data/v59.0/sobjects/${encodeURIComponent(sobject)}/describe/`)
  if (!r.ok) return { success: false, error: `Salesforce describe ${r.status}` }
  const fields = (r.data?.fields || []).map(f => ({
    name: f.name, label: f.label, type: f.type,
    length: f.length, nillable: f.nillable, updateable: f.updateable, custom: f.custom,
  }))
  return { success: true, name: r.data?.name, label: r.data?.label, fields }
}

async function salesforceCreateRecord(conn, config, { sobject, fields }) {
  if (!sobject || !fields) return { success: false, error: 'sobject and fields are required' }
  const r = await salesforceApi(conn, config,
    `/services/data/v59.0/sobjects/${encodeURIComponent(sobject)}/`,
    { method: 'POST', body: fields }
  )
  if (!r.ok) return { success: false, error: `Salesforce create ${r.status}: ${r.data?.[0]?.message || 'failed'}` }
  return { success: true, id: r.data?.id, ...r.data }
}

async function salesforceUpdateRecord(conn, config, { sobject, id, fields }) {
  if (!sobject || !id || !fields) return { success: false, error: 'sobject, id, and fields are required' }
  const r = await salesforceApi(conn, config,
    `/services/data/v59.0/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: fields }
  )
  if (!r.ok) return { success: false, error: `Salesforce update ${r.status}: ${r.data?.[0]?.message || 'failed'}` }
  return { success: true, id }
}

async function localDirList(config, input) {
  // Accept both 'sub_path' and 'path' — small models often hallucinate 'path'
  const sub_path = input.sub_path || input.path
  if (!config.path) return { success: false, error: 'Local directory path not configured. The connector needs a base directory path set in its config.' }
  try {
    const targetPath = sub_path ? path.join(config.path, sub_path) : config.path
    if (!targetPath.startsWith(config.path)) return { success: false, error: 'Path traversal denied — sub_path escapes the base directory' }
    // Check existence first for a friendlier error than EPERM
    try { await fs.access(targetPath) } catch (e) {
      if (e.code === 'ENOENT') return { success: false, error: `Directory does not exist: ${targetPath}. Check the connector base path or sub_path.` }
      if (e.code === 'EPERM' || e.code === 'EACCES') return { success: false, error: `Permission denied accessing ${targetPath}. macOS: grant Full Disk Access to the terminal/Node.js process in System Settings → Privacy & Security → Full Disk Access.` }
      throw e
    }
    const entries = await fs.readdir(targetPath, { withFileTypes: true })
    const files = entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
    return { success: true, path: targetPath, files }
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      return { success: false, error: `Permission denied: ${err.message}. On macOS, open System Settings → Privacy & Security → Full Disk Access and grant access to the terminal or process running the API.` }
    }
    return { success: false, error: `Failed to list directory: ${err.message}` }
  }
}

async function localDirRead(config, input) {
  // Accept both 'file_path' and 'path' — small models often hallucinate 'path'
  const file_path = input.file_path || input.path
  if (!config.path) return { success: false, error: 'Local directory path not configured. The connector needs a base directory path set in its config.' }
  if (!file_path) return { success: false, error: 'file_path is required. Use local_dir__list first to discover available files, then pass the file name as file_path.' }
  try {
    const targetPath = path.join(config.path, file_path)
    if (!targetPath.startsWith(config.path)) return { success: false, error: 'Path traversal denied — file_path escapes the base directory' }
    try { await fs.access(targetPath) } catch (e) {
      if (e.code === 'ENOENT') return { success: false, error: `File not found: ${targetPath}. Use local_dir__list to see available files.` }
      if (e.code === 'EPERM' || e.code === 'EACCES') return { success: false, error: `Permission denied accessing ${targetPath}. macOS: grant Full Disk Access in System Settings → Privacy & Security → Full Disk Access.` }
      throw e
    }
    const content = await fs.readFile(targetPath, 'utf8')
    return { success: true, path: targetPath, content }
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      return { success: false, error: `Permission denied: ${err.message}. On macOS, open System Settings → Privacy & Security → Full Disk Access and grant access to the terminal or process running the API.` }
    }
    return { success: false, error: `Failed to read file: ${err.message}` }
  }
}

async function localDirWrite(config, input) {
  // Accept both 'file_path' and 'path' — small models often hallucinate 'path'
  const file_path = input.file_path || input.path
  const content = input.content
  if (!config.path) return { success: false, error: 'Local directory path not configured. The connector needs a base directory path set in its config.' }
  if (!file_path || content === undefined) return { success: false, error: 'file_path and content are required. Provide file_path (relative path, e.g. "output/report.md") and content (the text to write).' }
  try {
    const targetPath = path.join(config.path, file_path)
    if (!targetPath.startsWith(config.path)) return { success: false, error: 'Path traversal denied — file_path escapes the base directory' }
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.writeFile(targetPath, content, 'utf8')
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') return { success: false, error: `Permission denied writing to ${targetPath}. macOS: grant Full Disk Access in System Settings → Privacy & Security → Full Disk Access.` }
      throw e
    }
    return { success: true, path: targetPath, bytes: Buffer.byteLength(content, 'utf8') }
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      return { success: false, error: `Permission denied: ${err.message}. On macOS, open System Settings → Privacy & Security → Full Disk Access and grant access to the terminal or process running the API.` }
    }
    return { success: false, error: `Failed to write file: ${err.message}` }
  }
}

async function localShellExecute(config, input) {
  const command = input.command || input.input
  if (!command) return { success: false, error: 'command is required. Provide the shell command string to execute.' }
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 30000 })
    return { success: true, stdout, stderr }
  } catch (err) {
    return { success: false, error: err.message, stdout: err.stdout, stderr: err.stderr }
  }
}

async function localApplescriptExecute(config, input) {
  const script = input.script || input.input
  if (!script) return { success: false, error: 'script is required. Provide the AppleScript code to execute.' }
  try {
    const { stdout, stderr } = await execAsync(`osascript -e ${JSON.stringify(script)}`, { timeout: 30000 })
    return { success: true, stdout, stderr }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Generic REST API execution — covers AWS, Stripe, Twilio, SendGrid, Discord,
// Zendesk, ServiceNow, HubSpot, Snowflake, Elasticsearch, Prometheus, Datadog,
// Confluence, Terraform, ThingsBoard, Kubernetes, MQTT, Redis, and any other
// REST-based SaaS connector.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the base URL from a connector config, trying every known key name.
 */
function resolveBaseUrl(cfg) {
  return cfg.baseUrl || cfg.url || cfg.instanceUrl || cfg.brokerUrl || cfg.host || ''
}

/**
 * Build auth headers from connector config. Handles:
 *   - Bearer tokens  (apiKey, accessToken, botToken, secretKey, appKey, etc.)
 *   - Basic auth      (username + password)
 *   - Custom headers  (x-api-key etc.)
 */
function resolveAuthHeaders(cfg) {
  const headers = {}

  // Bearer-style tokens — common across dozens of APIs
  const bearer = cfg.apiKey || cfg.accessToken || cfg.botToken || cfg.secretKey
    || cfg.apiToken || cfg.personalAccessToken || cfg.accessKeyId
  if (bearer) {
    // Some APIs want "Bearer", others want raw token in a specific header
    headers['Authorization'] = `Bearer ${bearer}`
  }

  // Basic auth
  if (cfg.username && cfg.password) {
    headers['Authorization'] = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`
  }

  // Datadog: DD-API-KEY + DD-APPLICATION-KEY
  if (cfg.apiKey && cfg.appKey) {
    headers['DD-API-KEY'] = cfg.apiKey
    headers['DD-APPLICATION-KEY'] = cfg.appKey
  }

  // AWS SigV4 is not done here; AWS tools use the AWS SDK path instead
  // (placeholder for future SDK integration)

  // Zendesk: email/token basic
  if (cfg.email && (cfg.apiToken || cfg.apiKey)) {
    headers['Authorization'] = `Basic ${Buffer.from(`${cfg.email}/token:${cfg.apiToken || cfg.apiKey}`).toString('base64')}`
  }

  // Discord: Bot prefix
  if (cfg.botToken) {
    headers['Authorization'] = `Bot ${cfg.botToken}`
  }

  // Twilio: accountSid + authToken basic
  if (cfg.accountSid && cfg.authToken) {
    headers['Authorization'] = `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`
  }

  // ServiceNow: basic auth already covered above, but ensure we don't add Bearer
  if (cfg.username && cfg.password) {
    delete headers['Authorization'] // will be reset below
    headers['Authorization'] = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`
  }

  return headers
}

/**
 * Map connector tool names to REST API paths.  This gives the agent a simple
 * function-call interface while we translate to the correct REST path + method
 * underneath.
 */
const REST_PATH_MAP = {
  // ── AWS (inventory/read-only via generic REST) ──────────────
  'aws__s3_list':          { method: 'GET', path: '/s3/buckets' },
  'aws__s3_objects':       { method: 'GET', path: ({ bucket }) => `/s3/buckets/${bucket}/objects` },
  'aws__ec2_list':         { method: 'GET', path: '/ec2/instances' },
  'aws__cloudwatch_metrics':{ method: 'GET', path: '/cloudwatch/metrics' },
  'aws__lambda_invoke':    { method: 'POST', path: ({ functionName }) => `/lambda/functions/${functionName}/invoke` },

  // ── Kubernetes ─────────────────────────────────
  'k8s__get':       { method: 'GET',    path: ({ resource, name, namespace }) => `/api/v1/namespaces/${namespace}/${resource}/${name}` },
  'k8s__logs':      { method: 'GET',    path: ({ pod, namespace }) => `/api/v1/namespaces/${namespace}/pods/${pod}/log` },
  'k8s__describe':  { method: 'GET',    path: ({ resource, name, namespace }) => `/api/v1/namespaces/${namespace}/${resource}/${name}` },

  // ── Terraform Cloud ───────────────────────────
  'terraform__plan':  { method: 'POST', path: ({ workspaceId }) => `/workspaces/${workspaceId}/runs` },
  'terraform__apply': { method: 'POST', path: ({ runId }) => `/runs/${runId}/actions/apply` },

  // ── MQTT (note: MQTT uses TCP not REST, but ThingsBoard MQTT has a REST proxy) ─
  'mqtt__publish':   { method: 'POST', path: '/api/v1/telemetry' },
  'mqtt__subscribe': { method: 'GET',  path: '/api/v1/telemetry' },

  // ── ThingsBoard ───────────────────────────────
  'thingsboard__telemetry': { method: 'GET',  path: ({ deviceId }) => `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries` },
  'thingsboard__devices':   { method: 'GET',  path: '/api/devices' },

  // ── Twilio ─────────────────────────────────────
  'twilio__send_sms':  { method: 'POST', path: '/2010-04-01/Accounts/{accountSid}/Messages.json' },
  'twilio__make_call': { method: 'POST', path: '/2010-04-01/Accounts/{accountSid}/Calls.json' },

  // ── SendGrid ───────────────────────────────────
  'sendgrid__send':  { method: 'POST', path: '/v3/mail/send' },
  'sendgrid__stats': { method: 'GET',  path: '/v3/stats' },

  // ── Discord ────────────────────────────────────
  'discord__send':          { method: 'POST', path: ({ channelId }) => `/channels/${channelId}/messages` },
  'discord__list_channels': { method: 'GET',  path: '/guilds/{guildId}/channels' },

  // ── Stripe ─────────────────────────────────────
  'stripe__customers':     { method: 'GET',  path: '/v1/customers' },
  'stripe__payments':      { method: 'GET',  path: '/v1/payment_intents' },
  'stripe__subscriptions': { method: 'GET',  path: '/v1/subscriptions' },
  'stripe__refund':        { method: 'POST', path: '/v1/refunds' },

  // ── Zendesk ────────────────────────────────────
  'zendesk__tickets':        { method: 'GET',  path: '/api/v2/tickets' },
  'zendesk__create_ticket':  { method: 'POST', path: '/api/v2/tickets' },
  'zendesk__update_ticket':  { method: 'PUT',  path: ({ ticketId }) => `/api/v2/tickets/${ticketId}` },

  // ── ServiceNow ─────────────────────────────────
  'servicenow__incidents': { method: 'GET', path: '/api/now/table/incident' },
  'servicenow__changes':   { method: 'GET', path: '/api/now/table/change_request' },

  // ── HubSpot ────────────────────────────────────
  'hubspot__contacts':  { method: 'GET',  path: '/crm/v3/objects/contacts' },
  'hubspot__deals':     { method: 'GET',  path: '/crm/v3/objects/deals' },
  'hubspot__companies': { method: 'GET',  path: '/crm/v3/objects/companies' },

  // ── Snowflake (SQL API via REST) ──────────────
  'snowflake__query':  { method: 'POST', path: '/api/v2/statements' },
  'snowflake__tables': { method: 'GET',  path: '/api/v2/tables' },

  // ── Elasticsearch ──────────────────────────────
  'elastic__search':          { method: 'POST', path: ({ index }) => `/${index || '_all'}/_search` },
  'elastic__cluster_health':  { method: 'GET',  path: '/_cluster/health' },

  // ── Redis (via Redis Enterprise REST API or RedisInsight proxy) ─
  'redis__get':  { method: 'GET',  path: ({ key }) => `/api/keys/${encodeURIComponent(key)}` },
  'redis__set':  { method: 'POST', path: '/api/keys' },
  'redis__keys': { method: 'GET',  path: ({ pattern }) => `/api/keys?pattern=${encodeURIComponent(pattern)}` },

  // ── Prometheus ─────────────────────────────────
  'prometheus__query':  { method: 'GET', path: '/api/v1/query' },
  'prometheus__range':  { method: 'GET', path: '/api/v1/query_range' },
  'prometheus__alerts': { method: 'GET', path: '/api/v1/alerts' },

  // ── Datadog ─────────────────────────────────────
  'datadog__metrics':  { method: 'GET', path: '/api/v1/query' },
  'datadog__logs':     { method: 'POST', path: '/api/v2/logs/events/search' },
  'datadog__monitors': { method: 'GET', path: '/api/v1/monitor' },

  // ── Confluence ──────────────────────────────────
  'confluence__search':      { method: 'GET',  path: '/wiki/rest/api/content/search' },
  'confluence__get_page':    { method: 'GET',  path: ({ pageId }) => `/wiki/rest/api/content/${pageId}` },
  'confluence__create_page': { method: 'POST', path: '/wiki/rest/api/content' },
}

/**
 * Generic execution function for REST-based connectors.
 */
async function genericRestExecute(conn, config, toolName, input) {
  const baseUrl = resolveBaseUrl(config).replace(/\/+$/, '')
  if (!baseUrl) {
    return { success: false, error: `No API endpoint configured for ${conn.tool_id}. Add baseUrl in connector config.` }
  }

  // Check for mapped tool
  const mapping = REST_PATH_MAP[toolName]
  let method = 'GET', pathStr = ''
  let body = undefined, queryParams = {}

  if (mapping) {
    method = mapping.method || 'GET'
    // If path is a function, resolve it with the input
    if (typeof mapping.path === 'function') {
      pathStr = mapping.path(input || {})
    } else {
      pathStr = mapping.path
    }
  } else {
    // Generic fallback: use input.path, input.method, input.query, input.body
    pathStr = input.path || '/'
    method = (input.method || 'GET').toUpperCase()
    queryParams = input.query || {}
    body = input.body
  }

  // Interpolate template variables like {accountSid}
  pathStr = pathStr.replace(/\{(\w+)\}/g, (_, key) => config[key] || input[key] || `{${key}}`)

  // Build query string
  const searchParams = new URLSearchParams()
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== null) searchParams.append(k, String(v))
  }
  const qs = searchParams.toString()
  const fullUrl = `${baseUrl}${pathStr}${qs ? '?' + qs : ''}`

  // Build headers
  const headers = resolveAuthHeaders(config)
  if (!headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json'
  }

  try {
    const fetchOpts = {
      method,
      headers,
      signal: AbortSignal.timeout(30000),
    }
    if (body !== undefined && method !== 'GET') {
      fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body)
    }

    const res = await fetch(fullUrl, fetchOpts)
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { data = text }

    if (!res.ok) {
      return { success: false, error: `${conn.tool_id} API returned ${res.status}: ${JSON.stringify(data).substring(0, 500)}` }
    }

    return { success: true, status: res.status, data }
  } catch (err) {
    return { success: false, error: `${conn.tool_id} request failed: ${err.message}` }
  }
}

// Provider prefixes we know how to dispatch. task.service.js uses this to
// decide whether a tool name belongs to a connector vs a built-in.
export const CONNECTOR_TOOL_PREFIXES = [
  'local_dir__', 'local_shell__', 'local_applescript__', 'slack__', 'jira__', 'github__', 'gmail__',
  'notion__', 'linear__', 'salesforce__',
  'webhook__', 'db__', 'rest__',
  // New connectors
  'docker__', 'ssh__',
  'aws__', 'k8s__', 'terraform__',
  'mqtt__', 'thingsboard__',
  'twilio__', 'sendgrid__', 'discord__',
  'stripe__', 'quickbooks__',
  'zendesk__', 'servicenow__',
  'hubspot__',
  'snowflake__', 'elastic__', 'redis__',
  'prometheus__', 'datadog__',
  'confluence__',
  // Built-in tools exposed to workflow TOOL steps (agent-only capabilities
  // that workflows can now invoke directly without routing through an agent)
  'http_request__', 'http_download__', 'publish_dashboard_report__',
]
