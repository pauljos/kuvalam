// apps/api/src/db/pool.js
// Phase 3: RLS-aware connection pool using AsyncLocalStorage
import pg from 'pg'
import { AsyncLocalStorage } from 'async_hooks'

const { Pool } = pg

// UUID v4 pattern — validates tenant IDs before interpolating into SQL session vars
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validateTenantId(tenantId) {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`Invalid tenant ID format: ${tenantId}`)
  }
  return tenantId
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.PG_MAX_POOL_SIZE || '10', 10),
  idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
  // 10s connection timeout: long enough to survive traffic spikes and short
  // failovers without cascading into 500s, while still failing fast for
  // genuinely unresponsive DBs. (Was 2000ms — too tight for cold starts.)
  connectionTimeoutMillis: parseInt(process.env.PG_CONNECT_TIMEOUT_MS || '10000', 10),
  // Recycle connections after 30 min — prevents stale/zombie connections
  // from accumulating when the DB server kills them from its side
  maxLifetime: 30 * 60 * 1000,
  // Allow the pool to close idle connections when the pool is shutting down
  allowExitOnIdle: true,
})


pool.on('error', (err) => {
  console.error('Unexpected DB pool error', err)
})

// ─── Tenant isolation context ───────────────────────────────────────────────
// Each request that carries a :tenantId in the URL gets an ALS context with:
//   { tenantId, client? }
// The client is lazily acquired on the first query() call and reused for the
// entire request lifetime. This eliminates the per-query BEGIN/COMMIT overhead
// (3 round-trips per query) and replaces it with a single SESSION-level SET
// that persists on the connection until release.
//
// Before: every query → connect + BEGIN + SET LOCAL + query + COMMIT + release
// After:  first query → connect + SET SESSION … then → query → query → …
//         onResponse → release
export const tenantContextStore = new AsyncLocalStorage()

/**
 * Release the per-request tenant DB client (if one was acquired).
 * Called from the Fastify onResponse hook. Idempotent — safe to call
 * when no client was acquired (e.g. auth-only routes).
 *
 * Accepts an optional store reference so callers (Fastify hooks) can
 * release deterministically even if the ALS context has been lost
 * (e.g. across error boundaries or the response completion tick).
 */
export function releaseTenantClient(store) {
  const ctx = store || tenantContextStore.getStore()
  if (ctx?.client) {
    // Reset the session var so the connection is clean for the next tenant
    ctx.client.query('RESET app.current_tenant_id').catch(() => {})
    try { ctx.client.release() } catch { /* already released */ }
    ctx.client = null
  }
}

/** Runtime pool telemetry — exposed via /metrics for pool-leak diagnosis. */
export function poolStats() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  }
}

// Helper: run a query.
// Each query acquires its own short-lived pool connection, so Promise.all
// parallelism works correctly. Tenant isolation is enforced via explicit
// WHERE tenant_id = $N clauses (RLS session-variable path was dead code).
export async function query(text, params) {
  const start = Date.now()
  const res = await pool.query(text, params)
  const duration = Date.now() - start
  if (process.env.NODE_ENV === 'development' && duration > 100) {
    console.log('Slow query', { text: text.substring(0, 60), duration, rows: res.rowCount })
  }
  return res
}

// Helper: get a client for transactions
export async function getClient() {
  const client = await pool.connect()
  const ctx = tenantContextStore.getStore()
  if (ctx?.tenantId) {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', validateTenantId(ctx.tenantId)])
  }
  return client
}

// Helper: run a transaction (automatically carries RLS tenant context)
export async function transaction(fn) {
  const client = await pool.connect()
  const ctx = tenantContextStore.getStore()
  try {
    await client.query('BEGIN')
    if (ctx?.tenantId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', validateTenantId(ctx.tenantId)])
    }
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export default pool
