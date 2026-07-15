// apps/api/src/index.js — Kuvalam API Server
import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import { createRequire } from 'module'

import authRoutes from './routes/auth.routes.js'
import tenantRoutes from './routes/tenant.routes.js'
import agentRoutes from './routes/agent.routes.js'
import knowledgeRoutes from './routes/knowledge.routes.js'
import settingsRoutes from './routes/settings.routes.js'
import workflowRoutes from './routes/workflow.routes.js'
import approvalsRoutes from './routes/approvals.routes.js'
import connectorsRoutes from './routes/connectors.routes.js'
import auditRoutes from './routes/audit.routes.js'
import analyticsRoutes from './routes/analytics.routes.js'
import oauthRoutes from './routes/oauth.routes.js'
import adminRoutes from './routes/admin.routes.js'
import triggersRoutes from './routes/triggers.routes.js'
import a2aRoutes from './routes/a2a.routes.js'
import mcpRoutes from './routes/mcp.routes.js'
import feedbackRoutes from './routes/feedback.routes.js'
import profileRoutes from './routes/profile.routes.js'
import { initQueues, getQueueStats, shutdownQueues } from './services/queue.service.js'
import { startScheduler, stopScheduler, getSchedulerStatus } from './services/scheduler.service.js'
import { initTelemetry } from './services/telemetry.service.js'

const fastify = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined
  }
})

// ─── Plugins ──────────────────────────────────────────────────────────────
// Security headers — helmet must be registered before routes.
// CSP is relaxed for the API since no HTML is served; CSP is enforced by the web app.
await fastify.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false
})

// CORS — strict origin allowlist. Never fall back to localhost in production.
const isProduction = process.env.NODE_ENV === 'production'
const rawFrontend = process.env.FRONTEND_URL || (isProduction ? '' : 'http://localhost:3000')
const allowedOrigins = rawFrontend.split(',').map(s => s.trim()).filter(Boolean)
if (isProduction && (allowedOrigins.length === 0 || allowedOrigins.some(o => /localhost|127\.0\.0\.1/i.test(o)))) {
  throw new Error('FRONTEND_URL must be set to one or more non-localhost origins in production')
}
await fastify.register(cors, {
  origin: (origin, cb) => {
    // Allow same-origin/no-origin (curl, health checks)
    if (!origin) return cb(null, true)
    if (allowedOrigins.includes(origin)) return cb(null, true)
    return cb(new Error('Origin not allowed by CORS policy'), false)
  },
  credentials: true
})

await fastify.register(cookie, {
  secret: (() => {
    const s = process.env.COOKIE_SECRET
    if (!s || s.length < 32) {
      if (isProduction) throw new Error('COOKIE_SECRET must be set to a 32+ char secret in production')
      return 'kuvalam-dev-cookie-secret-min-32-chars'
    }
    return s
  })(),
  parseOptions: {}
})

await fastify.register(jwt, {
  secret: (() => {
    if (!process.env.JWT_SECRET && isProduction) {
      throw new Error('JWT_SECRET environment variable must be set in production')
    }
    return process.env.JWT_SECRET || 'kuvalam-dev-secret-min-32-chars-change-in-prod'
  })(),
  // Read JWT from cookie (httpOnly) as well as Authorization header
  cookie: {
    cookieName: 'kuvalam_token',
    signed: false
  }
})

await fastify.register(multipart, {
  limits: { fileSize: 50 * 1024 * 1024, files: 1 } // 50MB, single file per request
})

// Global rate limit — per-route stricter limits are applied via `config.rateLimit` on sensitive endpoints.
await fastify.register(rateLimit, {
  max: 200,
  timeWindow: '1 minute',
  allowList: (req) => req.url === '/health'
})

// ─── RLS Context Hook ──────────────────────────────────────────────────────
import { tenantContextStore } from './db/pool.js'

const TENANT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

fastify.addHook('onRequest', (request, reply, done) => {
  const match = request.url.match(/\/tenants\/([^/?#]+)/)
  const tenantId = match ? match[1] : request.headers['x-tenant-id']

  if (tenantId && TENANT_UUID_RE.test(tenantId)) {
    tenantContextStore.run(tenantId, done)
  } else {
    done()
  }
})

// ─── Auth decorator ────────────────────────────────────────────────────────
fastify.decorate('authenticate', async function (request, reply) {
  try {
    await request.jwtVerify()
  } catch (err) {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHENTICATED', message: 'Valid authentication token required' },
      meta: { timestamp: new Date().toISOString() }
    })
    // Throw so any calling hook / preHandler stops executing and does not fall through
    throw err
  }

  // Enforce tenant IDOR guard immediately after successful auth, whenever a
  // route contains :tenantId. Defence-in-depth in addition to Postgres RLS.
  if (request.params?.tenantId) {
    await fastify.validateTenantAccess(request, reply)
    if (reply.sent) throw new Error('Tenant access denied')
  }
})

// Tenant IDOR guard — for any route with :tenantId in the URL, ensure the
// authenticated user is a member of that tenant. System admins bypass this check.
// Membership is loaded lazily and cached in-request.
import { query as _q } from './db/pool.js'
const _tenantMembershipCache = new Map() // key = `${userId}:${tenantId}` → boolean; capped size
async function _isTenantMember(userId, tenantId) {
  const key = `${userId}:${tenantId}`
  if (_tenantMembershipCache.has(key)) return _tenantMembershipCache.get(key)
  const { rows } = await _q(
    `SELECT 1 FROM tenant_members WHERE user_id = $1 AND tenant_id = $2 AND status = 'ACTIVE' LIMIT 1`,
    [userId, tenantId]
  )
  const ok = rows.length > 0
  if (_tenantMembershipCache.size > 5000) _tenantMembershipCache.clear()
  _tenantMembershipCache.set(key, ok)
  return ok
}

fastify.decorate('validateTenantAccess', async function (request, reply) {
  const urlTenantId = request.params?.tenantId
  if (!urlTenantId) return // no tenant in URL, nothing to check
  if (!TENANT_UUID_RE.test(urlTenantId)) {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_TENANT_ID', message: 'Malformed tenant identifier' }
    })
  }
  const user = request.user
  if (!user) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' }
    })
  }
  if (user.isSystemAdmin) return // system admins can access any tenant
  const ok = await _isTenantMember(user.sub, urlTenantId)
  if (!ok) {
    request.log.warn({ userId: user.sub, urlTenantId, jwtTenantId: user.tenantId }, 'Tenant access denied')
    return reply.status(403).send({
      success: false,
      error: { code: 'TENANT_FORBIDDEN', message: 'You do not have access to this tenant' }
    })
  }
})

// Invalidate a membership cache entry — call when a user's tenant membership changes
fastify.decorate('invalidateTenantMembership', function (userId, tenantId) {
  _tenantMembershipCache.delete(`${userId}:${tenantId}`)
})

// ─── Health check ──────────────────────────────────────────────────────────
fastify.get('/health', async () => {
  const queue = await getQueueStats().catch(() => ({ available: false }))
  const scheduler = getSchedulerStatus()
  return {
    status: 'ok',
    service: 'kuvalam-api',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    queue,
    scheduler
  }
})

fastify.get('/', async () => ({
  name: 'Kuvalam API',
  version: '0.1.0',
  description: 'AI Workforce Operating System',
  docs: '/api/v1'
}))

// ─── Routes ───────────────────────────────────────────────────────────────
await fastify.register(authRoutes, { prefix: '/api/v1' })
await fastify.register(tenantRoutes, { prefix: '/api/v1' })
await fastify.register(agentRoutes, { prefix: '/api/v1' })
await fastify.register(knowledgeRoutes, { prefix: '/api/v1' })
await fastify.register(settingsRoutes, { prefix: '/api/v1' })
await fastify.register(workflowRoutes, { prefix: '/api/v1' })
await fastify.register(approvalsRoutes, { prefix: '/api/v1' })
await fastify.register(connectorsRoutes, { prefix: '/api/v1' })
await fastify.register(auditRoutes, { prefix: '/api/v1' })
await fastify.register(analyticsRoutes, { prefix: '/api/v1' })
await fastify.register(oauthRoutes, { prefix: '/api/v1' })
await fastify.register(adminRoutes, { prefix: '/api/v1' })
await fastify.register(triggersRoutes, { prefix: '/api/v1' })
await fastify.register(a2aRoutes, { prefix: '/api/v1' })
await fastify.register(mcpRoutes, { prefix: '/api/v1' })
await fastify.register(feedbackRoutes, { prefix: '/api/v1' })
await fastify.register(profileRoutes, { prefix: '/api/v1' })

// ─── Global error handler ──────────────────────────────────────────────────
fastify.setErrorHandler(async (error, request, reply) => {
  fastify.log.error(error)
  const statusCode = error.statusCode || 500
  return reply.status(statusCode).send({
    success: false,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: statusCode >= 500 ? 'Internal server error' : error.message,
      // Forward AppError.details so the UI can act on structured errors
      // (e.g. OAUTH_APP_NOT_CONFIGURED includes { provider, redirectUri }
      // so the BYOC form knows which backend provider to configure).
      ...(statusCode < 500 && error.details ? { details: error.details } : {})
    },
    meta: { requestId: request.id, timestamp: new Date().toISOString() }
  })
})

// ─── Start ────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3001')
const HOST = process.env.HOST || '0.0.0.0'

try {
  await fastify.listen({ port: PORT, host: HOST })
  fastify.log.info(`🚀 Kuvalam API running on http://localhost:${PORT}`)
  fastify.log.info(`📧 MailHog UI: http://localhost:8025`)
  fastify.log.info(`🗄️  Database: ${process.env.DATABASE_URL?.split('@')[1] || 'localhost:5432'}`)

  // Initialise BullMQ queue workers (non-blocking — degrades to in-process if no Redis)
  initQueues(fastify.log).then(ready => {
    fastify.log.info(`📬 Job queue: ${ready ? 'BullMQ/Redis' : 'in-process fallback'}`)
  })

  // Start cron-based workflow schedule trigger (non-blocking)
  startScheduler().catch(err => fastify.log.warn(`[Scheduler] Startup error: ${err.message}`))

  // Initialise real-time telemetry WebSocket server
  initTelemetry(fastify.server, (token) => fastify.jwt.verify(token))

} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────
async function gracefulShutdown(signal) {
  fastify.log.info(`Received ${signal} — shutting down`)
  stopScheduler()
  await shutdownQueues(fastify.log).catch(() => {})
  await fastify.close()
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
