// apps/api/src/services/startup-provision.service.js
// ─────────────────────────────────────────────────────────────────────────────
// Startup Auto-Provisioning for Knowledge Infrastructure
//
// Runs once when the API server starts (non-production only). Automatically:
//   1. Checks if Docker is available
//   2. Ensures pgvector container is running (starts if needed)
//   3. Ensures Neo4j container is running (optional, best-effort)
//   4. Auto-creates tool_connections records so Knowledge Bases & Graphs
//      work immediately — no manual "Register Backend" button clicks needed.
//
// Environment variables for multi-machine portability:
//   K8_PGVECTOR_CONTAINER  – Docker container name for pgvector (default: kuvalam-postgres)
//   K8_NEO4J_CONTAINER     – Docker container name for Neo4j (default: kuvalam-neo4j)
//   K8_PG_COMPOSE_SERVICE  – docker-compose service name for postgres (default: postgres)
//   K8_NEO4J_COMPOSE_SERVICE – docker-compose service name for neo4j (default: neo4j)
//   K8_AUTO_PROVISION      – Set to 'false' to disable auto-provisioning entirely
//   K8_AUTO_PROVISION_NEO4J – Set to 'false' to skip Neo4j auto-provisioning
//
// On production (NODE_ENV=production), this module is a no-op — infra is
// expected to be managed externally (cloud DB, managed Neo4j, etc.).
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { query } from '../db/pool.js'
import { encryptCredentials } from './crypto.service.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const DOCKER_COMPOSE = path.join(PROJECT_ROOT, 'docker-compose.yml')

// ── Configurable names (same env vars as knowledge-infra.service.js) ───────
const PG_CONTAINER      = process.env.K8_PGVECTOR_CONTAINER || 'kuvalam-postgres'
const NEO4J_CONTAINER   = process.env.K8_NEO4J_CONTAINER || 'kuvalam-neo4j'
const PG_COMPOSE_SVC    = process.env.K8_PG_COMPOSE_SERVICE || 'postgres'
const NEO4J_COMPOSE_SVC = process.env.K8_NEO4J_COMPOSE_SERVICE || 'neo4j'

// ── Resolve pg connection details ─────────────────────────────────────────
// Priority: explicit env vars → parse DATABASE_URL → defaults
function resolvePgCreds() {
  if (process.env.PGHOST && process.env.PGUSER) {
    return {
      host: process.env.PGHOST,
      port: process.env.PGPORT || '5434',
      user: process.env.PGUSER,
      database: process.env.PGDATABASE || 'kuvalam_db',
    }
  }
  const url = process.env.DATABASE_URL || ''
  const m = url.match(/postgres(?:ql)?:\/\/([^:]+):[^@]+@([^:]+):(\d+)\/(.+)/)
  if (m) {
    return { user: m[1], host: m[2], port: m[3], database: m[4] }
  }
  return { host: 'localhost', port: '5434', user: 'kuvalam', database: 'kuvalam_db' }
}
const _pgCreds = resolvePgCreds()
const PG_HOST = _pgCreds.host
const PG_PORT = _pgCreds.port
const PG_USER = _pgCreds.user
const PG_DB   = _pgCreds.database

const NEO4J_HOST      = process.env.NEO4J_HOST || 'localhost'
const NEO4J_PORT_BOLT = process.env.NEO4J_BOLT_PORT || '7687'
const NEO4J_PORT_HTTP = process.env.NEO4J_HTTP_PORT || '7474'
const NEO4J_USER      = process.env.NEO4J_USER || 'neo4j'
const NEO4J_DB        = process.env.NEO4J_DATABASE || 'neo4j'

// ─── Helpers ───────────────────────────────────────────────────────────────

function runQuiet(cmd, timeoutMs = 15_000) {
  try {
    const out = execSync(cmd, { timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, stdout: out.toString('utf8').trim(), stderr: '' }
  } catch (e) {
    return { ok: false, stdout: '', stderr: (e.stderr || e.message || '').toString() }
  }
}

function dockerRunning() {
  const r = runQuiet('docker info --format "{{.ServerVersion}}" 2>/dev/null')
  return r.ok && r.stdout.length > 0
}

function containerUp(name) {
  const r = runQuiet(`docker inspect -f '{{.State.Status}}' "${name}" 2>/dev/null`)
  return r.ok && r.stdout.trim() === 'running'
}

async function pgvectorHealthy() {
  try {
    const r = runQuiet(
      `docker exec ${PG_CONTAINER} psql -U "${PG_USER}" -d "${PG_DB}" -c "SELECT count(*) FROM pg_extension WHERE extname='vector'" -t 2>/dev/null`
    )
    return r.ok && r.stdout.includes('1')
  } catch { return false }
}

async function neo4jHealthy() {
  try {
    const resp = await fetch(`http://${NEO4J_HOST}:${NEO4J_PORT_HTTP}`, { signal: AbortSignal.timeout(5000) })
    return resp.ok
  } catch { return false }
}

// ─── Connector auto-creation ───────────────────────────────────────────────

/**
 * Creates a tool_connection for a locally provisioned knowledge service.
 * Idempotent — if a connector already exists, just activates it.
 */
async function ensureConnector(tenantId, service, log) {
  const toolId = service === 'pgvector' ? 'vector-db' : 'knowledge-graph'

  // Check existing
  const { rows: existing } = await query(
    `SELECT id, status FROM tool_connections
     WHERE tenant_id = $1 AND tool_id = $2 AND status != 'INACTIVE'
     LIMIT 1`,
    [tenantId, toolId]
  )

  if (existing.length > 0) {
    if (existing[0].status === 'PENDING') {
      await query(
        `UPDATE tool_connections SET status = 'ACTIVE', last_tested_at = NOW()
         WHERE id = $1`, [existing[0].id]
      )
      log.info(`🔌 Auto-provision: activated existing ${service} connector (was PENDING)`)
    } else {
      log.info(`🔌 Auto-provision: ${service} connector already active — skipping`)
    }
    return { created: false, connectorId: existing[0].id }
  }

  // Create new connector
  if (service === 'pgvector') {
    const config = encryptCredentials({
      kind: 'pgvector',
      baseUrl: `postgresql://${PG_USER}:***@${PG_HOST}:${PG_PORT}/${PG_DB}`,
      host: PG_HOST,
      port: PG_PORT,
      user: PG_USER,
      database: PG_DB,
      embeddingModel: 'text-embedding-3-large',
      dimensions: '1536',
    })

    const { rows: [conn] } = await query(
      `INSERT INTO tool_connections (tenant_id, tool_id, name, auth_type, config, deployment_type, status)
       VALUES ($1, $2, $3, 'API_KEY', $4, 'local', 'ACTIVE')
       RETURNING id`,
      [tenantId, 'vector-db', `Local pgvector (${PG_HOST}:${PG_PORT})`, config]
    )
    log.info(`🔌 Auto-provision: created pgvector connector (id=${conn.id})`)
    return { created: true, connectorId: conn.id }
  }

  if (service === 'neo4j') {
    const config = encryptCredentials({
      kind: 'neo4j',
      baseUrl: `bolt://${NEO4J_HOST}:${NEO4J_PORT_BOLT}`,
      username: NEO4J_USER,
      database: NEO4J_DB,
    })

    const { rows: [conn] } = await query(
      `INSERT INTO tool_connections (tenant_id, tool_id, name, auth_type, config, deployment_type, status)
       VALUES ($1, $2, $3, 'API_KEY', $4, 'local', 'ACTIVE')
       RETURNING id`,
      [tenantId, 'knowledge-graph', `Local Neo4j (${NEO4J_HOST}:${NEO4J_PORT_BOLT})`, config]
    )
    log.info(`🔌 Auto-provision: created Neo4j connector (id=${conn.id})`)
    return { created: true, connectorId: conn.id }
  }

  return { created: false, connectorId: null }
}

// ─── Main auto-provision entry point ───────────────────────────────────────

/**
 * Called once on API startup. Detects Docker, ensures containers are running,
 * and auto-creates tool_connection records so Knowledge Bases & Graphs work
 * out of the box — no manual UI clicks needed.
 *
 * @param {object} log - Fastify/Pino logger
 * @returns {object} Summary of what was provisioned
 */
export async function autoProvisionKnowledgeInfra(log) {
  // ── Guard: skip in production ──────────────────────────────────────────
  if (process.env.NODE_ENV === 'production') {
    log.info('🏭 Production mode — skipping knowledge infra auto-provision (expect managed cloud services)')
    return { provisioned: false, reason: 'production' }
  }

  // ── Guard: explicit opt-out ────────────────────────────────────────────
  if (process.env.K8_AUTO_PROVISION === 'false') {
    log.info('⏭️  K8_AUTO_PROVISION=false — skipping knowledge infra auto-provision')
    return { provisioned: false, reason: 'opt-out' }
  }

  log.info('🔍 Auto-provisioning knowledge infrastructure…')

  const result = {
    provisioned: false,
    docker: { available: false },
    pgvector: { running: false, containerStarted: false, connectorCreated: false, connectorId: null },
    neo4j: { running: false, containerStarted: false, connectorCreated: false, connectorId: null, skipped: false },
  }

  // ── Step 1: Check Docker ──────────────────────────────────────────────
  const dockerOk = dockerRunning()
  result.docker.available = dockerOk

  if (!dockerOk) {
    log.warn('⚠️  Docker not available — cannot auto-provision knowledge containers.')
    log.warn('   Install Docker: https://www.docker.com/products/docker-desktop/')
    log.warn('   Or run: brew install --cask docker')
    return result
  }

  log.info('🐳 Docker is available')

  // ── Step 2: Get tenant IDs to provision ───────────────────────────────
  // We provision for ALL tenants — each gets its own connector record.
  const { rows: tenants } = await query(`SELECT id FROM tenants WHERE status = 'ACTIVE'`)
  if (tenants.length === 0) {
    log.warn('⚠️  No active tenants found — skipping connector creation')
    return result
  }

  // ── Step 3: Ensure pgvector is running ────────────────────────────────
  const pgUp = containerUp(PG_CONTAINER)
  if (!pgUp) {
    log.info(`🐘 pgvector container "${PG_CONTAINER}" not running — starting via docker compose…`)
    const r = runQuiet(`docker compose -f "${DOCKER_COMPOSE}" up -d ${PG_COMPOSE_SVC} 2>&1`, 60_000)
    if (r.ok || containerUp(PG_CONTAINER)) {
      log.info(`✅ pgvector container "${PG_CONTAINER}" started successfully`)
      result.pgvector.containerStarted = true
      // Wait for postgres to be ready
      await new Promise(resolve => setTimeout(resolve, 3000))
    } else {
      log.warn(`⚠️  Failed to start pgvector container: ${r.stderr.slice(0, 200)}`)
    }
  } else {
    log.info(`🐘 pgvector container "${PG_CONTAINER}" already running`)
  }

  // Health check
  const pgHealthy = containerUp(PG_CONTAINER) && (await pgvectorHealthy())
  result.pgvector.running = pgHealthy

  if (pgHealthy) {
    // Create connector for each tenant
    for (const t of tenants) {
      try {
        const { connectorId } = await ensureConnector(t.id, 'pgvector', log)
        if (connectorId) {
          result.pgvector.connectorId = connectorId
          result.pgvector.connectorCreated = true
        }
      } catch (e) {
        log.warn(`⚠️  Failed to create pgvector connector for tenant ${t.id}: ${e.message}`)
      }
    }
    result.provisioned = true
  } else {
    log.warn('⚠️  pgvector health check failed — skipping connector creation')
  }

  // ── Step 4: Ensure Neo4j is running (best-effort, optional) ───────────
  const neo4jOptOut = process.env.K8_AUTO_PROVISION_NEO4J === 'false'
  if (neo4jOptOut) {
    log.info('⏭️  K8_AUTO_PROVISION_NEO4J=false — skipping Neo4j auto-provision')
    result.neo4j.skipped = true
  } else {
    const neo4jUp = containerUp(NEO4J_CONTAINER)
    if (!neo4jUp) {
      log.info(`🕸️  Neo4j container "${NEO4J_CONTAINER}" not running — starting via docker compose --profile graph…`)
      const r = runQuiet(`docker compose --profile graph -f "${DOCKER_COMPOSE}" up -d ${NEO4J_COMPOSE_SVC} 2>&1`, 60_000)
      if (r.ok) {
        // Neo4j takes a while to initialize — wait for it
        log.info('⏳ Waiting for Neo4j to become healthy (up to 30s)…')
        for (let i = 0; i < 15; i++) {
          await new Promise(resolve => setTimeout(resolve, 2000))
          if (containerUp(NEO4J_CONTAINER) && (await neo4jHealthy())) {
            log.info(`✅ Neo4j container "${NEO4J_CONTAINER}" started and healthy`)
            result.neo4j.containerStarted = true
            break
          }
        }
      } else {
        log.warn(`⚠️  Failed to start Neo4j container: ${r.stderr.slice(0, 200)}`)
        log.warn('   (Neo4j is optional — Knowledge Bases work without it)')
      }
    } else {
      log.info(`🕸️  Neo4j container "${NEO4J_CONTAINER}" already running`)
    }

    const neo4jOk = containerUp(NEO4J_CONTAINER) && (await neo4jHealthy())
    result.neo4j.running = neo4jOk

    if (neo4jOk) {
      for (const t of tenants) {
        try {
          const { connectorId } = await ensureConnector(t.id, 'neo4j', log)
          if (connectorId) {
            result.neo4j.connectorId = connectorId
            result.neo4j.connectorCreated = true
          }
        } catch (e) {
          log.warn(`⚠️  Failed to create Neo4j connector for tenant ${t.id}: ${e.message}`)
        }
      }
      result.provisioned = true
    } else {
      log.warn('⚠️  Neo4j not healthy — skipping connector creation (optional)')
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log.info('📋 Knowledge Infra Auto-Provision Summary:')
  log.info(`   Docker:      ${dockerOk ? '✅ available' : '❌ not found'}`)
  log.info(`   pgvector:    ${pgHealthy ? '✅ running & connected' : '❌ not available'}`)
  log.info(`   Neo4j:       ${result.neo4j.skipped ? '⏭️  skipped' : result.neo4j.running ? '✅ running & connected' : '⚠️  not available (optional)'}`)
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  return result
}
