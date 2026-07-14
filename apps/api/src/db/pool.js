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
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

pool.on('error', (err) => {
  console.error('Unexpected DB pool error', err)
})

// Store for tenant isolation context propagation
export const tenantContextStore = new AsyncLocalStorage()

// Helper: run a query (automatically injects RLS tenant context if present in AsyncLocalStorage)
export async function query(text, params) {
  const tenantId = tenantContextStore.getStore()
  
  if (tenantId) {
    // If tenant context is active, obtain a client to run commands in the same transaction session
    const client = await pool.connect()
    try {
      await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', validateTenantId(tenantId)])
      const start = Date.now()
      const res = await client.query(text, params)
      const duration = Date.now() - start
      if (process.env.NODE_ENV === 'development' && duration > 100) {
        console.log('Slow tenant query', { text: text.substring(0, 60), duration, rows: res.rowCount, tenantId })
      }
      return res
    } finally {
      client.release()
    }
  }

  // Non-RLS fallback (for auth/system queries)
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
  const tenantId = tenantContextStore.getStore()
  if (tenantId) {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', validateTenantId(tenantId)])
  }
  return client
}

// Helper: run a transaction (automatically carries RLS tenant context)
export async function transaction(fn) {
  const client = await pool.connect()
  const tenantId = tenantContextStore.getStore()
  try {
    await client.query('BEGIN')
    if (tenantId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', validateTenantId(tenantId)])
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
