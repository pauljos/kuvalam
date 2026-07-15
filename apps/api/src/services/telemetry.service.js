// apps/api/src/services/telemetry.service.js
// Phase 3: Live telemetry server using standard WebSockets
import { WebSocketServer } from 'ws'

let wss = null
const clients = new Map() // tenantId -> Set<WebSocket>

/**
 * @param {import('http').Server} server
 * @param {(token: string) => object} verifyToken  — fastify.jwt.verify wrapper
 */
export function initTelemetry(server, verifyToken) {
  wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`)

    // Validate request path e.g. /ws/tenants/:tenantId/telemetry
    const match = url.pathname.match(/\/ws\/tenants\/([^/]+)\/telemetry/)
    if (!match) {
      socket.destroy()
      return
    }

    const tenantId = match[1]

    // ── JWT authentication ────────────────────────────────────────────────
    // Accept token from:
    //   1. Authorization: Bearer <token> header
    //   2. ?token= query param
    //   3. kuvalam_token httpOnly cookie (set by auth routes)
    let rawToken = null
    const authHeader = request.headers['authorization']
    if (authHeader && authHeader.startsWith('Bearer ')) {
      rawToken = authHeader.slice(7)
    } else if (url.searchParams.has('token')) {
      rawToken = url.searchParams.get('token')
    } else if (request.headers.cookie) {
      // Parse cookie string manually — no cookie library in this upgrade handler
      const cookieMatch = request.headers.cookie
        .split(';')
        .map(c => c.trim())
        .find(c => c.startsWith('kuvalam_token='))
      if (cookieMatch) rawToken = cookieMatch.slice('kuvalam_token='.length)
    }

    if (!rawToken) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    let decoded
    try {
      decoded = verifyToken(rawToken)
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // Ensure the JWT's tenant claim matches the path tenant
    if (decoded.tenantId !== tenantId) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, tenantId)
    })
  })

  wss.on('connection', (ws, tenantId) => {
    if (!clients.has(tenantId)) {
      clients.set(tenantId, new Set())
    }
    clients.get(tenantId).add(ws)

    ws.on('close', () => {
      const tenantClients = clients.get(tenantId)
      if (tenantClients) {
        tenantClients.delete(ws)
        if (tenantClients.size === 0) {
          clients.delete(tenantId)
        }
      }
    })

    ws.on('error', () => {
      // WebSocket errors are expected during normal disconnect flows
    })
  })
}

/**
 * Broadcast an execution event to all connected clients for a tenant
 * @param {string} tenantId
 * @param {string} eventType e.g., 'workflow.step_started', 'agent.thinking'
 * @param {object} payload data payload
 */
export function broadcastTelemetry(tenantId, eventType, payload) {
  if (!wss) return

  const tenantClients = clients.get(tenantId)
  if (!tenantClients || tenantClients.size === 0) return

  const message = JSON.stringify({
    eventType,
    payload,
    timestamp: new Date().toISOString()
  })

  for (const client of tenantClients) {
    if (client.readyState === 1) { // OPEN
      client.send(message)
    }
  }
}
