// apps/api/src/services/knowledge-infra.service.js
// Knowledge Infrastructure provisioning service.
// Checks Docker status for pgvector (PostgreSQL) and Neo4j,
// starts containers, and creates tool_connections pointing to them.
//
// Used by the Settings → Knowledge Infrastructure tab for local deployments.

import { execSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { query } from '../db/pool.js'
import { encryptCredentials, decryptCredentials } from './crypto.service.js'
import { auditLog } from '../utils/audit.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Project root: go up from apps/api/src/services to the repo root
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const DOCKER_COMPOSE = path.join(PROJECT_ROOT, 'docker-compose.yml')

// ── Container names (configurable via env for multi-machine portability) ───
// On a new machine running docker-compose.yml, these default to kuvalam-* names.
// If containers were started with different names, set these env vars.
const PG_CONTAINER  = process.env.K8_PGVECTOR_CONTAINER || 'kuvalam-postgres'
const NEO4J_CONTAINER = process.env.K8_NEO4J_CONTAINER || 'kuvalam-neo4j'
const PG_COMPOSE_SVC = process.env.K8_PG_COMPOSE_SERVICE || 'postgres'
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
  // Parse DATABASE_URL: postgresql://user:pass@host:port/db
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

const NEO4J_PORT_HTTP = process.env.NEO4J_HTTP_PORT || '7474'
const NEO4J_PORT_BOLT = process.env.NEO4J_BOLT_PORT || '7687'
const NEO4J_USER      = process.env.NEO4J_USER || 'neo4j'
const NEO4J_DB        = process.env.NEO4J_DATABASE || 'neo4j'

// ─── Helpers ───────────────────────────────────────────────────────────────

function runQuiet(cmd) {
  try {
    const out = execSync(cmd, { timeout: 8_000, stdio: ['ignore', 'pipe', 'pipe'] })
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

// Real HTTP health checks (Docker inspect can show "running" but the service
// may still be starting up.)
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

const NEO4J_HOST = process.env.NEO4J_HOST || 'localhost'

// ─── Status ────────────────────────────────────────────────────────────────

/**
 * Returns the status of both knowledge infrastructure services and any
 * existing connectors pointing to them.
 */
export async function getKnowledgeInfraStatus(tenantId) {
  const dockerOk = dockerRunning()

  // ── pgvector ───────────────────────────────────────────────────────────
  const pgContainerUp = dockerOk && containerUp(PG_CONTAINER)
  const pgHealthy = pgContainerUp ? await pgvectorHealthy() : false

  // ── Neo4j ──────────────────────────────────────────────────────────────
  const neo4jContainerUp = dockerOk && containerUp(NEO4J_CONTAINER)
  const neo4jOk = neo4jContainerUp ? await neo4jHealthy() : false

  // ── Existing connectors ────────────────────────────────────────────────
  const { rows: connectors } = await query(
    `SELECT id, tool_id, name, status, config, deployment_type, created_at
     FROM tool_connections
     WHERE tenant_id = $1 AND tool_id IN ('vector-db', 'knowledge-graph')
     ORDER BY created_at DESC`,
    [tenantId]
  )
  const decrypted = connectors.map(r => ({
    ...r,
    config: decryptCredentials(r.config || {})
  }))

  return {
    docker: {
      available: dockerOk,
      hostname: dockerOk ? runQuiet('docker info --format "{{.Name}}"').stdout : null,
    },
    pgvector: {
      running: pgHealthy,
      containerUp: pgContainerUp,
      host: PG_HOST,
      port: PG_PORT,
      user: PG_USER,
      database: PG_DB,
      connectorId: decrypted.find(c => c.tool_id === 'vector-db' && c.status !== 'INACTIVE')?.id || null,
      connectorName: decrypted.find(c => c.tool_id === 'vector-db')?.name || null,
    },
    neo4j: {
      running: neo4jOk,
      containerUp: neo4jContainerUp,
      host: NEO4J_HOST,
      httpPort: NEO4J_PORT_HTTP,
      boltPort: NEO4J_PORT_BOLT,
      user: NEO4J_USER,
      database: NEO4J_DB,
      connectorId: decrypted.find(c => c.tool_id === 'knowledge-graph' && c.status !== 'INACTIVE')?.id || null,
      connectorName: decrypted.find(c => c.tool_id === 'knowledge-graph')?.name || null,
    },
    connectors: decrypted,
  }
}

// ─── Provision (start Docker services) ─────────────────────────────────────

export async function startKnowledgeService(service) {
  if (service === 'pgvector') {
    // PostgreSQL/pgvector is the main DB — it's started via the main
    // docker-compose services. Just ensure it's up.
    const r = runQuiet(`docker compose -f "${DOCKER_COMPOSE}" up -d ${PG_COMPOSE_SVC} 2>&1`)
    return {
      success: r.ok || containerUp(PG_CONTAINER),
      output: r.stdout || r.stderr,
      alreadyRunning: containerUp(PG_CONTAINER),
    }
  }

  if (service === 'neo4j') {
    const alreadyUp = containerUp(NEO4J_CONTAINER)
    if (alreadyUp) {
      return { success: true, output: 'Neo4j is already running', alreadyRunning: true }
    }
    const r = runQuiet(`docker compose --profile graph -f "${DOCKER_COMPOSE}" up -d neo4j 2>&1`)
    // Wait a few seconds for Neo4j to be ready
    if (r.ok) {
      await new Promise(resolve => setTimeout(resolve, 6000))
    }
    const healthy = await neo4jHealthy()
    return {
      success: healthy,
      output: r.stdout || r.stderr,
      alreadyRunning: false,
    }
  }

  throw Object.assign(new Error(`Unknown service: ${service}`), { statusCode: 400 })
}

// ─── Auto-create connector ─────────────────────────────────────────────────

/**
 * Creates a tool_connection for a locally provisioned knowledge service,
 * prefilled with the correct connection details (host, port, credentials).
 */
export async function createInfraConnector(tenantId, actorId, service) {
  // Check if a connector already exists
  const toolId = service === 'pgvector' ? 'vector-db' : 'knowledge-graph'
  const { rows: existing } = await query(
    `SELECT id FROM tool_connections
     WHERE tenant_id = $1 AND tool_id = $2 AND status != 'INACTIVE'
     LIMIT 1`,
    [tenantId, toolId]
  )
  if (existing.length > 0) {
    // Auto-activate if it was PENDING
    await query(
      `UPDATE tool_connections SET status = 'ACTIVE', last_tested_at = NOW()
       WHERE id = $1 AND status = 'PENDING'`,
      [existing[0].id]
    )
    const { rows: [conn] } = await query(
      `SELECT id, tenant_id, tool_id, name, auth_type, deployment_type, status, created_at
       FROM tool_connections WHERE id = $1`,
      [existing[0].id]
    )
    return { connector: conn, alreadyExisted: true }
  }

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
       RETURNING id, tenant_id, tool_id, name, auth_type, deployment_type, status, created_at`,
      [tenantId, 'vector-db', `Local pgvector (${PG_HOST}:${PG_PORT})`, config]
    )

    await auditLog({
      tenantId, eventType: 'connector.created', actorId, actorType: 'USER',
      resourceType: 'ToolConnection', resourceId: conn.id, action: 'CREATE_CONNECTOR',
      metadata: { service: 'pgvector', source: 'knowledge-infra' }
    })

    return { connector: conn, alreadyExisted: false }
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
       RETURNING id, tenant_id, tool_id, name, auth_type, deployment_type, status, created_at`,
      [tenantId, 'knowledge-graph', `Local Neo4j (${NEO4J_HOST}:${NEO4J_PORT_BOLT})`, config]
    )

    await auditLog({
      tenantId, eventType: 'connector.created', actorId, actorType: 'USER',
      resourceType: 'ToolConnection', resourceId: conn.id, action: 'CREATE_CONNECTOR',
      metadata: { service: 'neo4j', source: 'knowledge-infra' }
    })

    return { connector: conn, alreadyExisted: false }
  }

  throw Object.assign(new Error(`Unknown service: ${service}`), { statusCode: 400 })
}
