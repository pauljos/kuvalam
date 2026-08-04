// apps/api/src/index.js — Kuvalam API Server
import 'dotenv/config'

// ─── NODE_ENV normalisation ──────────────────────────────────────────────
// If NODE_ENV is unset, default to 'development' so that fallback-secret
// guards (which check `!== 'production'`) don't silently use weak dev secrets
// when someone forgets to set the env var.
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'development'
}

const isProduction = process.env.NODE_ENV === 'production'

// Module-level interval handles so gracefulShutdown can clear them (fix #14)
let _staleTaskCleanupInterval = null
let _auditRetentionInterval = null


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
import customModelsRoutes from './routes/custom-models.routes.js'
import reportsRoutes from './routes/reports.routes.js'
import taskOutputsRoutes from './routes/task-outputs.routes.js'
import agentLogsRoutes from './routes/agent-logs.routes.js'
import artifactsRoutes from './routes/artifacts.routes.js'
import chatRoutes from './routes/chat.routes.js'
import webhookReceiverRoutes from './routes/webhook-receiver.routes.js'
import whatsappRoutes from './routes/whatsapp.routes.js'
import telegramRoutes from './routes/telegram.routes.js'
import builderRoutes from './routes/builder.routes.js'
import systemRoutes from './routes/system.routes.js'
import knowledgeInfraRoutes from './routes/knowledge-infra.routes.js'
import knowledgeGraphRoutes from './routes/knowledge-graph.routes.js'
import supervisorRoutes from './routes/supervisor.routes.js'
import { initQueues, getQueueStats, shutdownQueues } from './services/queue.service.js'
import { startScheduler, stopScheduler, getSchedulerStatus } from './services/scheduler.service.js'
import { initTelemetry } from './services/telemetry.service.js'
import { initCache, shutdownCache } from './services/cache.service.js'
import { recoverOrphanedTraining } from './services/custom-models.service.js'
import { autoProvisionKnowledgeInfra } from './services/startup-provision.service.js'
import { validateOrigin } from './middleware/csrf.js'

const fastify = Fastify({
  logger: {
    level: isProduction ? 'info' : 'debug',
    transport: !isProduction
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
  hsts: isProduction
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false
})

// CORS — strict origin allowlist. Never fall back to localhost in production.
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
      // Always require COOKIE_SECRET — never fall back to a hardcoded secret,
      // even in development. A weak secret in any environment allows cookie
      // forgery and session hijacking.
      throw new Error('COOKIE_SECRET must be set to a secure random string (min 32 characters). Generate one with: openssl rand -hex 32')
    }
    return s
  })(),
  parseOptions: {}
})

await fastify.register(jwt, {
  secret: (() => {
    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET environment variable is required. Please set it to a secure random string (min 32 characters).')
    }
    if (process.env.JWT_SECRET.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters long for security.')
    }
    return process.env.JWT_SECRET
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
  allowList: (req) => req.url === '/health' || req.url === '/metrics'
})

// ─── RLS Context Hook ──────────────────────────────────────────────────────
import { tenantContextStore, releaseTenantClient, poolStats, query as _q } from './db/pool.js'

const TENANT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

fastify.addHook('onRequest', (request, reply, done) => {
  const match = request.url.match(/\/tenants\/([^/?#]+)/)
  const tenantId = match ? match[1] : request.headers['x-tenant-id']

  if (tenantId && TENANT_UUID_RE.test(tenantId)) {
    // Store an object so we can cache a per-request DB client on it.
    // tenantContextStore.getStore() is now { tenantId, client? }
    // Also stash on `request` as a fallback so onResponse can release
    // deterministically even if the ALS context is lost.
    const store = { tenantId }
    request._tenantStore = store
    tenantContextStore.run(store, done)
  } else {
    done()
  }
})

// Release the per-request tenant DB client when the response is sent.
// This is the complement to the lazy-acquire in pool.js → query().
fastify.addHook('onResponse', (request, reply, done) => {
  releaseTenantClient(request._tenantStore)
  done()
})

// CSRF protection — validate Origin/Referer on state-changing requests
fastify.addHook('onRequest', validateOrigin)

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
  // Use 'in' check — empty string is a valid param value in Fastify but
  // must be rejected before it reaches a UUID-typed DB column.
  if (request.params && 'tenantId' in request.params) {
    await fastify.validateTenantAccess(request, reply)
    if (reply.sent) throw new Error('Tenant access denied')
  }
})

// Tenant IDOR guard — for any route with :tenantId in the URL, ensure the
// authenticated user is a member of that tenant. System admins bypass this check.
//
// ── Fix #3: TTL-based cache expiry ────────────────────────────────────────
// The original LRU-only cache had no time dimension: a revoked membership
// would be served from cache until LRU eviction — indefinitely in a busy
// system. Each entry now stores { value, expiresAt } with a 60-second TTL.
// This limits the stale-access window to at most 60s per instance.

const _tenantMembershipCache = new Map() // key = `${userId}:${tenantId}` → { value, expiresAt }
const MEMBERSHIP_CACHE_MAX = 5000
const MEMBERSHIP_CACHE_TTL_MS = 60_000 // 60 seconds

async function _isTenantMember(userId, tenantId) {
  const key = `${userId}:${tenantId}`
  const now = Date.now()
  const cached = _tenantMembershipCache.get(key)
  if (cached && cached.expiresAt > now) {
    // LRU touch — delete and re-insert so recent accesses stay alive
    _tenantMembershipCache.delete(key)
    _tenantMembershipCache.set(key, cached)
    return cached.value
  }
  // Entry missing or expired — query DB
  const { rows } = await _q(
    `SELECT 1 FROM tenant_members WHERE user_id = $1 AND tenant_id = $2 AND status = 'ACTIVE' LIMIT 1`,
    [userId, tenantId]
  )
  const ok = rows.length > 0
  // LRU eviction: remove the oldest entry (first key in insertion order)
  if (_tenantMembershipCache.size >= MEMBERSHIP_CACHE_MAX) {
    const oldest = _tenantMembershipCache.keys().next().value
    if (oldest !== undefined) _tenantMembershipCache.delete(oldest)
  }
  _tenantMembershipCache.set(key, { value: ok, expiresAt: now + MEMBERSHIP_CACHE_TTL_MS })
  return ok
}


fastify.decorate('validateTenantAccess', async function (request, reply) {
  const urlTenantId = request.params?.tenantId
  // Reject missing *and* empty tenantId — both would cause UUID errors downstream
  if (!urlTenantId || urlTenantId.trim() === '') {
    return reply.status(400).send({
      success: false,
      error: { code: 'INVALID_TENANT_ID', message: 'A valid tenant identifier is required' }
    })
  }
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

// ─── Prometheus-style metrics ───────────────────────────────────────────────
// Public (no auth) endpoint returning process + queue + agent_health metrics
// in the plaintext exposition format. Fleet-wide aggregates only — no
// per-tenant PII exposed here.
fastify.get('/metrics', async (_req, reply) => {
  const lines = []
  const mem = process.memoryUsage()
  lines.push('# HELP kuvalam_process_uptime_seconds Process uptime')
  lines.push('# TYPE kuvalam_process_uptime_seconds counter')
  lines.push(`kuvalam_process_uptime_seconds ${process.uptime().toFixed(1)}`)
  lines.push('# HELP kuvalam_process_memory_bytes Resident memory in bytes')
  lines.push('# TYPE kuvalam_process_memory_bytes gauge')
  lines.push(`kuvalam_process_memory_bytes{type="rss"} ${mem.rss}`)
  lines.push(`kuvalam_process_memory_bytes{type="heap_used"} ${mem.heapUsed}`)

  try {
    const q = await getQueueStats()
    if (q && q.available !== false) {
      for (const queueName of ['tasks', 'workflows']) {
        const stats = q[queueName]
        if (!stats || typeof stats !== 'object') continue
        for (const [state, count] of Object.entries(stats)) {
          if (typeof count !== 'number') continue
          lines.push(`kuvalam_queue_jobs{queue="${queueName}",state="${state}"} ${count}`)
        }
      }
    }
  } catch { /* queue not available */ }

  try {
    const { rows } = await _q(
      `SELECT circuit_state, COUNT(*)::int AS n,
              COALESCE(SUM(running_tasks), 0)::int AS running,
              COALESCE(SUM(completed_24h), 0)::int AS completed_24h,
              COALESCE(SUM(failed_24h), 0)::int AS failed_24h
         FROM agent_health
         GROUP BY circuit_state`
    )
    lines.push('# HELP kuvalam_agent_circuit Agents by circuit state')
    lines.push('# TYPE kuvalam_agent_circuit gauge')
    for (const r of rows) {
      lines.push(`kuvalam_agent_circuit{state="${r.circuit_state}"} ${r.n}`)
    }
    const total = rows.reduce((acc, r) => {
      acc.running += r.running
      acc.completed_24h += r.completed_24h
      acc.failed_24h += r.failed_24h
      return acc
    }, { running: 0, completed_24h: 0, failed_24h: 0 })
    lines.push(`kuvalam_agent_tasks_running ${total.running}`)
    lines.push(`kuvalam_agent_tasks_completed_24h ${total.completed_24h}`)
    lines.push(`kuvalam_agent_tasks_failed_24h ${total.failed_24h}`)
  } catch { /* agent_health not populated yet */ }

  // DB pool telemetry — catches connection leaks fast.
  try {
    const p = poolStats()
    lines.push('# HELP kuvalam_db_pool_connections DB pool connection counts')
    lines.push('# TYPE kuvalam_db_pool_connections gauge')
    lines.push(`kuvalam_db_pool_connections{state="total"} ${p.totalCount}`)
    lines.push(`kuvalam_db_pool_connections{state="idle"} ${p.idleCount}`)
    lines.push(`kuvalam_db_pool_connections{state="waiting"} ${p.waitingCount}`)
  } catch { /* pool stats unavailable */ }

  reply.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n')
})

fastify.get('/', async () => ({
  name: 'Kuvalam API',
  version: '0.1.0',
  description: 'AI Workforce Operating System',
  docs: '/api/v1'
}))

// Allow empty JSON bodies so POST endpoints without a required body (activate, cancel, link, etc.)
// don't throw FST_ERR_CTP_EMPTY_JSON_BODY. The route handler still validates content.
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  if (body === '' || body === undefined || body === null) {
    done(null, {})
  } else {
    try { done(null, JSON.parse(body)) } catch (err) { done(err) }
  }

})

// ─── ETag Conditional GET ──────────────────────────────────────────────────
// ── L4 Fix: ETag-based conditional GET reduces bandwidth for unchanged data ──
// For GET/HEAD requests, compute a lightweight ETag from the response body
// and return 304 Not Modified if the client's If-None-Match matches.
// This saves bandwidth for agent lists, analytics, audit logs, etc.
import { createHash } from 'crypto'

fastify.addHook('onSend', async (request, reply, payload) => {
  // Only apply to GET/HEAD with 200 responses that have a body
  if (request.method !== 'GET' && request.method !== 'HEAD') return payload
  if (reply.statusCode !== 200) return payload
  if (!payload || typeof payload !== 'string') return payload

  // Compute a weak ETag (W/"<first16chars>") from the response body
  const hash = createHash('sha1').update(payload).digest('base64url').slice(0, 16)
  const etag = `W/"${hash}"`

  reply.header('ETag', etag)

  // Check If-None-Match: if client already has this version, send 304
  const ifNoneMatch = request.headers['if-none-match']
  if (ifNoneMatch && ifNoneMatch === etag) {
    reply.status(304)
    return '' // empty body for 304
  }

  return payload
})

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
await fastify.register(customModelsRoutes, { prefix: '/api/v1' })
await fastify.register(reportsRoutes, { prefix: '/api/v1' })
await fastify.register(taskOutputsRoutes, { prefix: '/api/v1' })
await fastify.register(agentLogsRoutes, { prefix: '/api/v1' })
await fastify.register(artifactsRoutes, { prefix: '/api/v1' })
await fastify.register(chatRoutes, { prefix: '/api/v1' })
await fastify.register(webhookReceiverRoutes, { prefix: '/api/v1' })
await fastify.register(whatsappRoutes, { prefix: '/api/v1' })
await fastify.register(telegramRoutes, { prefix: '/api/v1' })
await fastify.register(builderRoutes, { prefix: '/api/v1' })
await fastify.register(systemRoutes, { prefix: '/api/v1' })
await fastify.register(knowledgeInfraRoutes, { prefix: '/api/v1' })
await fastify.register(knowledgeGraphRoutes, { prefix: '/api/v1' })
await fastify.register(supervisorRoutes, { prefix: '/api/v1' })

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
  fastify.log.info(`🌐 Browser agent: ${process.env.BROWSER_AGENT_URL || 'NOT CONFIGURED'}`)

  // ── Orphan recovery: mark any RUNNING tasks as FAILED on startup ────────
  // When the API process restarts, any tasks that were RUNNING in the previous
  // process are orphaned. They need to be marked FAILED so they don't stay
  // stuck forever and users can retry them.
  try {
    const pg = await import('pg')
    const client = new pg.default.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    const { rowCount } = await client.query(
      `UPDATE agent_tasks SET status = 'FAILED', error = $1, completed_at = NOW()
       WHERE status = 'RUNNING'`,
      ['Server restarted during execution — please retry']
    )
    if (rowCount > 0) {
      fastify.log.info(`🔄 Orphan recovery: marked ${rowCount} stuck RUNNING task(s) as FAILED`)
    }
    // Also recover orphaned workflow executions
    const { rowCount: wfCount } = await client.query(
      `UPDATE workflow_executions SET status = 'FAILED', error = $1::jsonb, completed_at = NOW()
       WHERE status = 'RUNNING'`,
      [JSON.stringify({ message: 'Server restarted during execution — please retry' })]
    )
    if (wfCount > 0) {
      fastify.log.info(`🔄 Orphan recovery: marked ${wfCount} stuck RUNNING workflow execution(s) as FAILED`)
    }
    await client.end()

    // ── Periodic stale task cleanup: every 30s, fail RUNNING tasks that
    // exceed TASK_TIMEOUT_MS. Uses the pool (not the raw client, which is
    // already closed after orphan recovery). Handles tasks stuck mid-execution
    // (e.g. hanging Ollama calls that outlive the AbortController).
    const TASK_TIMEOUT_MS = parseInt(process.env.TASK_TIMEOUT_MS || '120000') // 2 min
    const CLEANUP_INTERVAL_MS = 30_000
    // Store handle so gracefulShutdown can clear it (fix #14)
    _staleTaskCleanupInterval = setInterval(async () => {
      try {
        const cutoff = new Date(Date.now() - TASK_TIMEOUT_MS).toISOString()
        // Stale agent tasks
        const { rowCount: staleCount } = await _q(
          `UPDATE agent_tasks SET status = 'FAILED', error = $1, completed_at = NOW()
           WHERE status = 'RUNNING' AND started_at IS NOT NULL AND started_at < $2`,
          [`Task timed out — no heartbeat for ${TASK_TIMEOUT_MS / 1000}s`, cutoff]
        )
        if (staleCount > 0) {
          fastify.log.warn(`⏰ Stale task cleanup: marked ${staleCount} timed-out RUNNING task(s) as FAILED`)
        }
        // Stale workflow executions
        const { rowCount: staleWf } = await _q(
          `UPDATE workflow_executions SET status = 'FAILED', error = $1::jsonb, completed_at = NOW()
           WHERE status = 'RUNNING' AND started_at IS NOT NULL AND started_at < $2`,
          [JSON.stringify({ message: `Workflow timed out after ${TASK_TIMEOUT_MS / 1000}s` }), cutoff]
        )
        if (staleWf > 0) {
          fastify.log.warn(`⏰ Stale workflow cleanup: marked ${staleWf} timed-out RUNNING execution(s) as FAILED`)
        }
      } catch (e) { /* silently ignore — orphan recovery on next restart catches it */ }
    }, CLEANUP_INTERVAL_MS)
    fastify.log.info(`⏱️  Stale task cleaner: every ${CLEANUP_INTERVAL_MS / 1000}s (timeout: ${TASK_TIMEOUT_MS / 1000}s)`)

    // ── Periodic audit log retention: every 6 hours, delete records older
    // than AUDIT_RETENTION_DAYS (default 90 days). Keeps the table from
    // growing indefinitely — audit_log gets heavy with every LLM token usage.
    const AUDIT_RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS || '90')
    const AUDIT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000 // every 6 hours
    // Store handle so gracefulShutdown can clear it (fix #14)
    _auditRetentionInterval = setInterval(async () => {
      try {
        const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400_000).toISOString()
        const { rowCount: deleted } = await _q(
          `DELETE FROM audit_log WHERE created_at < $1`, [cutoff]
        )
        if (deleted > 0) {
          fastify.log.info(`🗄️  Audit retention: deleted ${deleted} records older than ${AUDIT_RETENTION_DAYS} days`)
        }
      } catch (e) {
        fastify.log.warn(`[AuditRetention] Cleanup failed: ${e.message}`)
      }
    }, AUDIT_CLEANUP_INTERVAL_MS)
    fastify.log.info(`🗄️  Audit retention: ${AUDIT_RETENTION_DAYS}d (cleanup every ${AUDIT_CLEANUP_INTERVAL_MS / 3600000}h)`)
  } catch (err) {
    fastify.log.warn(`[OrphanRecovery] Could not recover orphaned tasks: ${err.message}`)
  }

  // ── Training orphan recovery ────────────────────────────────────────────
  // If the server restarted while training was in progress, Python processes
  // are dead. Mark TRAINING models as FAILED so users can retry.
  recoverOrphanedTraining().then(rowCount => {
    if (rowCount > 0) fastify.log.info(`🔄 Training recovery: marked ${rowCount} stuck TRAINING model(s) as FAILED`)
  }).catch(err => fastify.log.warn(`[TrainingRecovery] ${err.message}`))

  // ── Auto-provision knowledge infra (Docker containers + connectors) ────
  // On first startup (or any restart), this ensures pgvector & Neo4j containers
  // are running and tool_connections exist. No manual button clicks needed.
  // Set K8_AUTO_PROVISION=false to disable. Skipped in production.
  autoProvisionKnowledgeInfra(fastify.log).catch(err =>
    fastify.log.warn(`[AutoProvision] Knowledge infra auto-provision failed: ${err.message}`)
  )

  // Initialise BullMQ queue workers (non-blocking — degrades to in-process if no Redis)
  initQueues(fastify.log).then(ready => {
    fastify.log.info(`📬 Job queue: ${ready ? 'BullMQ/Redis' : 'in-process fallback'}`)
  })

  // Initialize Redis cache
  const cacheReady = initCache()
  fastify.log.info(`💾 Cache: ${cacheReady ? 'Redis enabled' : 'disabled'}`)

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
  // Clear background intervals so they don't fire against a closing pool
  if (_staleTaskCleanupInterval) clearInterval(_staleTaskCleanupInterval)
  if (_auditRetentionInterval) clearInterval(_auditRetentionInterval)
  stopScheduler()
  await shutdownQueues(fastify.log).catch(() => {})
  await shutdownCache().catch(() => {})
  await fastify.close()
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
