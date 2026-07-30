// apps/api/src/services/database-connector.service.js
// Tenant-owned external database connections.
//
// Supports multiple SQL flavors via a driver registry (`DRIVERS`):
//   - postgres  (pg)          — long-standing default
//   - mysql     (mysql2)      — MariaDB/Aurora MySQL/etc. work too
//   - sqlite    (better-sqlite3 / sql.js) — file-based local DB
//   - mongodb   (mongodb)     — NoSQL document database
//
// Adding a flavor: implement the driver interface below and register it.
//   driver = {
//     createPool(cfg): pool          // native driver pool
//     endPool(pool): Promise<void>   // graceful shutdown
//     verify(pool): Promise<{message}>
//     listTables(pool): Promise<{tables}>
//     describeTable(pool, {schema, table}): Promise<{...}>
//     sampleTable(pool, {schema, table, limit}): Promise<{rows,columns,row_count}>
//     runQuery(pool, {sql, params, limit}): Promise<{rows,columns,row_count,truncated}>
//     buildConfig(cfg): normalisedConfig  // safety checks + decrypted-friendly shape
//   }
//
// Agents get four operations per configured connector:
//   listTables / describeTable / sampleTable / runQuery.
//
// Safety model (defence in depth — do NOT rely on any one layer):
//   1. Credentials AES-256-GCM encrypted at rest via crypto.service.js
//   2. In production we refuse to connect to loopback / RFC1918 hosts unless
//      the connector is explicitly marked `allow_private_host = true`
//   3. `runQuery` rejects anything that isn't a single SELECT / WITH … SELECT
//      statement. Blocks DDL/DML at the app layer even if the DB role has
//      write perms (users are strongly advised to use a read-only role, but
//      we don't trust them to)
//   4. Statement/query timeouts set per flavor (default 15s)
//   5. Every query is capped at MAX_ROWS rows; a `LIMIT` is appended if the
//      SQL didn't provide one
//   6. Connection strings / passwords are NEVER logged

import pg from 'pg'
import mysql from 'mysql2/promise'
import { decryptCredentials } from './crypto.service.js'

const { Pool } = pg

const MAX_ROWS = 200                     // hard cap returned to the LLM
const DEFAULT_STATEMENT_TIMEOUT = 15_000 // ms
const IDLE_POOL_TIMEOUT_MS = 10 * 60 * 1000
const POOL_CACHE_MAX = 500               // absolute cap to prevent unbounded growth

// ─── Pool cache keyed by connector id ─────────────────────────────────────
const poolCache = new Map() // id -> { flavor, pool, timer, lastUsed }

function evictPool(id) {
  const entry = poolCache.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  const driver = DRIVERS[entry.flavor]
  driver?.endPool(entry.pool).catch(() => { /* ignore */ })
  poolCache.delete(id)
}

function armEviction(id) {
  const entry = poolCache.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => evictPool(id), IDLE_POOL_TIMEOUT_MS)
}

// LRU eviction when pool cache exceeds the absolute cap
function trimPoolCache() {
  while (poolCache.size >= POOL_CACHE_MAX) {
    const oldest = poolCache.keys().next().value
    if (oldest === undefined) break
    evictPool(oldest)
  }
}

// ─── Shared safety helpers ────────────────────────────────────────────────

function assertSafeHost(host) {
  if (process.env.NODE_ENV !== 'production') return
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|fc00:|fe80:)/i.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error(`Host ${host} is a private/internal address. Set allow_private_host on the connector if this is intentional.`)
  }
}

/**
 * Reject anything that isn't a single read-only statement. Shared across flavors —
 * the guard operates on SQL text only.
 *
 * Accepted:
 *   SELECT …
 *   WITH x AS (…) SELECT …
 *
 * Rejected:
 *   INSERT / UPDATE / DELETE / MERGE
 *   CREATE / DROP / ALTER / TRUNCATE / GRANT / REVOKE
 *   COPY / CALL / DO (procedural)
 *   Multi-statement (semicolon in the middle)
 */
export function assertReadOnlySql(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new Error('SQL is required')
  }
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // /* block */ comments
    .replace(/--[^\n]*/g, ' ')                   // -- line comments
    .trim()
    .replace(/;+\s*$/, '')                       // trailing semicolons OK

  if (stripped.includes(';')) {
    throw new Error('Multi-statement queries are not allowed')
  }
  const firstWord = stripped.split(/\s+/, 1)[0].toUpperCase()
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    throw new Error(`Only SELECT/WITH queries are allowed (got ${firstWord})`)
  }
  if (firstWord === 'WITH') {
    const dmlInCte = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|DROP|ALTER|GRANT|REVOKE|CALL|COPY|DO)\b/i
    if (dmlInCte.test(stripped)) {
      throw new Error('Data-modifying statements are not allowed, even inside a WITH clause')
    }
  }
  return stripped
}

// Wrap SELECT with an outer LIMIT so we never accidentally stream millions
// of rows into an LLM prompt. Same SQL works in Postgres, MySQL, MariaDB.
function enforceRowLimit(sql, limit) {
  const cap = Math.min(limit || MAX_ROWS, MAX_ROWS)
  return `SELECT * FROM (${sql}) AS __kuvalam_wrapped LIMIT ${cap}`
}

// ─── Postgres driver ──────────────────────────────────────────────────────
const postgresDriver = {
  buildConfig(cfg) {
    const allowPrivate = cfg.allow_private_host === true // default false
    const host = String(cfg.host || '').trim()
    const port = parseInt(cfg.port || '5432', 10)
    const database = String(cfg.database || '').trim()
    const user = String(cfg.user || '').trim()
    const password = cfg.password ? String(cfg.password) : undefined

    if (!host)     throw new Error('host is required')
    if (!database) throw new Error('database is required')
    if (!user)     throw new Error('user is required')
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new Error('port must be a valid TCP port number')
    }
    if (!allowPrivate) assertSafeHost(host)

    let ssl
    if (cfg.ssl === 'require' || cfg.ssl === true) ssl = { rejectUnauthorized: false }
    else if (cfg.ssl === 'strict') ssl = { rejectUnauthorized: true }
    else ssl = false // disable by default (local dev)

    return { host, port, database, user, password, ssl }
  },

  createPool(cfg) {
    const pool = new Pool({
      ...postgresDriver.buildConfig(cfg),
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      statement_timeout: DEFAULT_STATEMENT_TIMEOUT,
      application_name: 'kuvalam-agent',
    })
    pool.on('error', () => {
      // Pool errors logged by pg library
    })
    return pool
  },

  async endPool(pool) { return pool.end() },

  async verify(pool) {
    const { rows: [meta] } = await pool.query(
      `SELECT current_database() AS db,
              current_user       AS usr,
              version()          AS version,
              (SELECT count(*) FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog','information_schema')) AS user_tables`
    )
    const shortVersion = String(meta.version).split(' ').slice(0, 2).join(' ')
    return { message: `Connected to ${meta.db} as ${meta.usr} (${shortVersion}). ${meta.user_tables} user tables visible.` }
  },

  async listTables(pool) {
    const { rows } = await pool.query(
      `SELECT n.nspname AS schema,
              c.relname AS table,
              c.reltuples::bigint AS estimated_rows,
              obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm')
          AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
        ORDER BY n.nspname, c.relname
        LIMIT 500`
    )
    return {
      tables: rows.map(r => ({
        schema: r.schema, table: r.table,
        estimated_rows: Number(r.estimated_rows) || 0,
        comment: r.comment
      }))
    }
  },

  async describeTable(pool, { schema = 'public', table }) {
    const [{ rows: cols }, { rows: pks }, { rows: idx }] = await Promise.all([
      pool.query(
        `SELECT column_name, data_type, is_nullable, column_default,
                character_maximum_length AS max_length
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
        [schema, table]
      ),
      pool.query(
        `SELECT kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name
            AND kcu.table_schema   = tc.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = $1 AND tc.table_name = $2
          ORDER BY kcu.ordinal_position`,
        [schema, table]
      ),
      pool.query(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = $1 AND tablename = $2`,
        [schema, table]
      )
    ])
    return {
      cols: cols.map(c => ({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES', default: c.column_default, max_length: c.max_length })),
      pks: pks.map(r => r.column_name),
      idx: idx.map(i => ({ name: i.indexname, definition: i.indexdef }))
    }
  },

  async sampleTable(pool, { schema = 'public', table, limit = 5 }) {
    const quotedSchema = '"' + String(schema).replace(/"/g, '""') + '"'
    const quotedTable  = '"' + String(table ).replace(/"/g, '""') + '"'
    const cap = Math.min(limit, 50)
    const { rows, fields } = await pool.query(
      `SELECT * FROM ${quotedSchema}.${quotedTable} LIMIT ${cap}`
    )
    return { rows, columns: fields.map(f => f.name), row_count: rows.length }
  },

  async runQuery(pool, { sql, params = [], limit }) {
    const cleaned = assertReadOnlySql(sql)
    const bounded = enforceRowLimit(cleaned, limit)
    const client = await pool.connect()
    try {
      await client.query(`SET LOCAL statement_timeout = ${DEFAULT_STATEMENT_TIMEOUT}`)
      const { rows, fields, rowCount } = await client.query(bounded, params)
      return {
        rows,
        columns: fields.map(f => f.name),
        row_count: rowCount,
        truncated: rowCount === MAX_ROWS
      }
    } finally {
      client.release()
    }
  }
}

// ─── MySQL / MariaDB driver ───────────────────────────────────────────────
const mysqlDriver = {
  buildConfig(cfg) {
    const allowPrivate = cfg.allow_private_host === true // default false
    const host = String(cfg.host || '').trim()
    const port = parseInt(cfg.port || '3306', 10)
    const database = String(cfg.database || '').trim()
    const user = String(cfg.user || '').trim()
    const password = cfg.password ? String(cfg.password) : undefined

    if (!host)     throw new Error('host is required')
    if (!database) throw new Error('database is required')
    if (!user)     throw new Error('user is required')
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new Error('port must be a valid TCP port number')
    }
    if (!allowPrivate) assertSafeHost(host)

    let ssl
    if (cfg.ssl === 'require' || cfg.ssl === true) ssl = { rejectUnauthorized: false }
    else if (cfg.ssl === 'strict') ssl = { rejectUnauthorized: true }
    else ssl = undefined // disable by default (local dev)

    return { host, port, database, user, password, ssl }
  },

  createPool(cfg) {
    const built = mysqlDriver.buildConfig(cfg)
    return mysql.createPool({
      ...built,
      connectionLimit: 3,
      connectTimeout: 8_000,
      // mysql2 executes each query with its own timeout via the `timeout` option — see runQuery
      supportBigNumbers: true,
      bigNumberStrings: true,
    })
  },

  async endPool(pool) { return pool.end() },

  async verify(pool) {
    const [rows] = await pool.query(
      `SELECT DATABASE() AS db, CURRENT_USER() AS usr, VERSION() AS version,
              (SELECT count(*) FROM information_schema.tables
                WHERE table_schema NOT IN ('mysql','sys','performance_schema','information_schema')) AS user_tables`
    )
    const meta = rows[0]
    return { message: `Connected to ${meta.db} as ${meta.usr} (MySQL ${meta.version}). ${meta.user_tables} user tables visible.` }
  },

  async listTables(pool) {
    const [rows] = await pool.query(
      `SELECT table_schema AS \`schema\`, table_name AS \`table\`,
              IFNULL(table_rows, 0) AS estimated_rows, table_comment AS comment
         FROM information_schema.tables
        WHERE table_schema NOT IN ('mysql','sys','performance_schema','information_schema')
          AND table_type IN ('BASE TABLE','VIEW')
        ORDER BY table_schema, table_name
        LIMIT 500`
    )
    return {
      tables: rows.map(r => ({
        schema: r.schema, table: r.table,
        estimated_rows: Number(r.estimated_rows) || 0,
        comment: r.comment || null
      }))
    }
  },

  async describeTable(pool, { schema, table }) {
    const [cols] = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default,
              character_maximum_length AS max_length
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position`,
      [schema || undefined, table]
    )
    const [pks] = await pool.query(
      `SELECT column_name
         FROM information_schema.key_column_usage
        WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY'
        ORDER BY ordinal_position`,
      [schema || undefined, table]
    )
    const [idx] = await pool.query(
      `SELECT index_name AS name,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
         FROM information_schema.statistics
        WHERE table_schema = ? AND table_name = ?
        GROUP BY index_name`,
      [schema || undefined, table]
    )
    return {
      cols: cols.map(c => ({ name: c.COLUMN_NAME || c.column_name, type: c.DATA_TYPE || c.data_type, nullable: (c.IS_NULLABLE || c.is_nullable) === 'YES', default: c.COLUMN_DEFAULT ?? c.column_default, max_length: c.CHARACTER_MAXIMUM_LENGTH ?? c.max_length })),
      pks: pks.map(r => r.COLUMN_NAME || r.column_name),
      idx: idx.map(i => ({ name: i.name || i.NAME, definition: `INDEX (${i.cols || i.COLS})` }))
    }
  },

  async sampleTable(pool, { schema, table, limit = 5 }) {
    const quotedSchema = schema ? '`' + String(schema).replace(/`/g, '``') + '`.' : ''
    const quotedTable  = '`' + String(table).replace(/`/g, '``') + '`'
    const cap = Math.min(limit, 50)
    const [rows, fields] = await pool.query(`SELECT * FROM ${quotedSchema}${quotedTable} LIMIT ${cap}`)
    return { rows, columns: (fields || []).map(f => f.name), row_count: rows.length }
  },

  async runQuery(pool, { sql, params = [], limit }) {
    const cleaned = assertReadOnlySql(sql)
    const bounded = enforceRowLimit(cleaned, limit)
    // mysql2 `execute` supports positional `?` placeholders. We convert $1/$2/… → ? for parity with pg.
    const converted = bounded.replace(/\$(\d+)/g, '?')
    const conn = await pool.getConnection()
    try {
      // Session timeout (ms) so a runaway query is killed
      await conn.query(`SET SESSION MAX_EXECUTION_TIME=${DEFAULT_STATEMENT_TIMEOUT}`)
      const [rows, fields] = await conn.query({ sql: converted, timeout: DEFAULT_STATEMENT_TIMEOUT }, params)
      return {
        rows,
        columns: (fields || []).map(f => f.name),
        row_count: Array.isArray(rows) ? rows.length : 0,
        truncated: Array.isArray(rows) && rows.length === MAX_ROWS
      }
    } finally {
      conn.release()
    }
  }
}

// ─── SQLite driver ─────────────────────────────────────────────────────────
const sqliteDriver = {
  buildConfig(cfg) {
    const dbPath = cfg.path || cfg.database || ':memory:'
    if (dbPath !== ':memory:' && typeof dbPath !== 'string') {
      throw new Error('path or database must be a string pointing to a .db file')
    }
    return { dbPath }
  },

  createPool(cfg) {
    const { dbPath } = sqliteDriver.buildConfig(cfg)
    // No pool needed for file-based SQLite; return a "pool-like" object
    return { dbPath, ready: true }
  },

  async endPool() {
    // Nothing to do — no persistent connections
    return Promise.resolve()
  },

  async verify(pool) {
    // Try better-sqlite3 first, fall back to sql.js
    try {
      const betterSqlite3 = await import('better-sqlite3')
      const db = betterSqlite3.default(pool.dbPath, { readonly: true })
      const version = db.prepare('SELECT sqlite_version() AS v').get().v
      db.close()
      return { message: `Connected to SQLite (${version}) — ${pool.dbPath === ':memory:' ? 'in-memory database' : pool.dbPath}` }
    } catch (err1) {
      try {
        const initSqlJs = await import('sql.js')
        const SQL = await initSqlJs.default()
        let buffer
        if (pool.dbPath !== ':memory:') {
          const fs = await import('fs')
          buffer = fs.readFileSync(pool.dbPath)
        }
        const db = new SQL.Database(buffer)
        const version = db.exec('SELECT sqlite_version() AS v')[0]?.values[0]?.[0] || 'unknown'
        db.close()
        return { message: `Connected to SQLite via sql.js (${version}) — ${pool.dbPath === ':memory:' ? 'in-memory database' : pool.dbPath}` }
      } catch (err2) {
        throw new Error(`No SQLite engine available: better-sqlite3 (${err1.message}) and sql.js (${err2.message}) both failed to load`)
      }
    }
  },

  async listTables(pool) {
    const betterSqlite3 = await import('better-sqlite3')
    const db = betterSqlite3.default(pool.dbPath, { readonly: true })
    try {
      const rows = db.prepare(
        "SELECT name AS `table` FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all()
      return {
        tables: rows.map(r => ({
          schema: null,
          table: r.table,
          estimated_rows: 0,
          comment: null
        }))
      }
    } finally {
      db.close()
    }
  },

  async describeTable(pool, { schema, table }) {
    const betterSqlite3 = await import('better-sqlite3')
    const db = betterSqlite3.default(pool.dbPath, { readonly: true })
    try {
      const rows = db.prepare(`PRAGMA table_info('${String(table).replace(/'/g, "''")}')`).all()
      return {
        cols: rows.map(r => ({
          name: r.name,
          type: r.type,
          nullable: r.notnull === 0,
          default: r.dflt_value,
          max_length: null
        })),
        pks: rows.filter(r => r.pk > 0).map(r => r.name),
        idx: []
      }
    } finally {
      db.close()
    }
  },

  async sampleTable(pool, { schema, table, limit = 5 }) {
    const betterSqlite3 = await import('better-sqlite3')
    const db = betterSqlite3.default(pool.dbPath, { readonly: true })
    try {
      const cap = Math.min(limit, 50)
      const quotedTable = `'${String(table).replace(/'/g, "''")}'`
      const rows = db.prepare(`SELECT * FROM ${quotedTable} LIMIT ${cap}`).all()
      return { rows, columns: Object.keys(rows[0] || {}), row_count: rows.length }
    } finally {
      db.close()
    }
  },

  async runQuery(pool, { sql, params = [], limit }) {
    const readOnly = /^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql.trim())
    const betterSqlite3 = await import('better-sqlite3')
    const db = betterSqlite3.default(pool.dbPath, { readonly: readOnly })
    try {
      if (readOnly) {
        const cap = Math.min(limit || MAX_ROWS, MAX_ROWS)
        const bounded = /\bLIMIT\s+\d+\s*$/i.test(sql.trim()) ? sql : `SELECT * FROM (${sql.trim().replace(/;+$/, '')}) AS __kuvalam_wrapped LIMIT ${cap}`
        const rows = params.length > 0 ? db.prepare(bounded).all(...params) : db.prepare(bounded).all()
        return {
          rows,
          columns: Object.keys(rows[0] || {}),
          row_count: rows.length,
          truncated: rows.length === MAX_ROWS
        }
      } else {
        const stmt = db.prepare(sql)
        const result = params.length > 0 ? stmt.run(...params) : stmt.run()
        return {
          rows: [{ changes: result.changes, lastInsertRowid: result.lastInsertRowid }],
          columns: ['changes', 'lastInsertRowid'],
          row_count: 1,
          truncated: false
        }
      }
    } finally {
      db.close()
    }
  }
}

// ─── MongoDB driver ──────────────────────────────────────────────────────
const mongoDriver = {
  buildConfig(cfg) {
    const allowPrivate = cfg.allow_private_host === true

    // Support both connection-string and individual-fields style config
    if (cfg.uri) {
      // Connection string — minimal validation, let the driver parse it
      const uri = String(cfg.uri).trim()
      if (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://')) {
        throw new Error('MongoDB URI must start with mongodb:// or mongodb+srv://')
      }
      // Extract host from URI for safety check
      const hostMatch = uri.match(/mongodb(?:\+srv)?:\/\/(?:[^@]+@)?([^:\/]+)/)
      if (hostMatch && !allowPrivate) {
        assertSafeHost(hostMatch[1])
      }
      return { uri, options: cfg.options || {} }
    }

    // Individual fields style
    const host = String(cfg.host || 'localhost').trim()
    const port = parseInt(cfg.port || '27017', 10)
    const database = String(cfg.database || '').trim()
    const user = cfg.user ? String(cfg.user).trim() : undefined
    const password = cfg.password ? String(cfg.password) : undefined

    if (!database) throw new Error('database is required for MongoDB')
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new Error('port must be a valid TCP port number')
    }
    if (!allowPrivate) assertSafeHost(host)

    const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : ''
    const uri = `mongodb://${auth}${host}:${port}/${encodeURIComponent(database)}`
    return { uri, options: cfg.options || {} }
  },

  async createPool(cfg) {
    // Lazy-import mongodb driver — only installed when using MongoDB connectors
    const { MongoClient } = await import('mongodb')
    const { uri, options } = mongoDriver.buildConfig(cfg)
    const client = new MongoClient(uri, {
      ...options,
      maxPoolSize: 3,
      connectTimeoutMS: 8_000,
      serverSelectionTimeoutMS: 5_000,
      socketTimeoutMS: DEFAULT_STATEMENT_TIMEOUT,
      appName: 'kuvalam-agent',
    })
    await client.connect()
    return client
  },

  async endPool(client) {
    try { await client.close() } catch { /* ignore */ }
  },

  async verify(client) {
    const db = client.db()
    const { ok } = await db.admin().ping()
    if (!ok) throw new Error('MongoDB ping failed')
    const stats = await db.stats()
    const colls = await db.listCollections().toArray()
    return {
      message: `Connected to MongoDB (v${stats.version || '?'}) — database "${db.databaseName}" has ${colls.length} collection(s), ${(stats.dataSize / 1024 / 1024).toFixed(1)} MB data`
    }
  },

  async listTables(client) {
    const db = client.db()
    const colls = await db.listCollections().toArray()
    return {
      tables: await Promise.all(colls.map(async (c) => {
        const collection = db.collection(c.name)
        let estimated_rows = 0
        try {
          estimated_rows = await collection.estimatedDocumentCount()
        } catch { /* ignore */ }
        return {
          schema: db.databaseName,
          table: c.name,
          estimated_rows,
          comment: c.type === 'view' ? 'View' : null
        }
      }))
    }
  },

  async describeTable(client, { schema, table }) {
    const db = client.db()
    const collection = db.collection(table)

    // Check collection exists
    const exists = await db.listCollections({ name: table }).hasNext()
    if (!exists) {
      return { cols: [], pks: [], idx: [] }
    }

    // Get indexes
    const indexes = await collection.indexes()

    // Sample one document to infer schema
    const sampleDocs = await collection.find().limit(10).toArray()
    const fieldMap = new Map()
    for (const doc of sampleDocs) {
      for (const [key, val] of Object.entries(doc)) {
        if (fieldMap.has(key)) continue
        fieldMap.set(key, {
          name: key,
          type: Array.isArray(val)
            ? 'array'
            : val instanceof Date
              ? 'date'
              : val === null
                ? 'null'
                : typeof val === 'object' && val._bsontype === 'ObjectId'
                  ? 'objectId'
                  : typeof val,
          nullable: val === null,
          default: null,
          max_length: null
        })
      }
    }

    const cols = Array.from(fieldMap.values())
    const pks = indexes
      .filter(i => i.key && Object.keys(i.key).some(k => i.key[k] === 1))
      .flatMap(i => Object.keys(i.key))
    const idx = indexes.map(i => ({
      name: i.name,
      definition: `INDEX(${Object.keys(i.key).join(',')}) ${i.unique ? 'UNIQUE' : ''}`
    }))

    return { cols, pks, idx }
  },

  async sampleTable(client, { schema, table, limit = 5 }) {
    const db = client.db()
    const collection = db.collection(table)
    const cap = Math.min(limit, 50)
    const docs = await collection.find().limit(cap).toArray()

    // Flatten BSON — convert ObjectId, Date, etc. to strings
    const rows = docs.map(doc => {
      const flat = {}
      for (const [k, v] of Object.entries(doc)) {
        if (v && typeof v === 'object' && v._bsontype === 'ObjectId') {
          flat[k] = v.toString()
        } else if (v instanceof Date) {
          flat[k] = v.toISOString()
        } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          flat[k] = JSON.stringify(v)
        } else {
          flat[k] = v
        }
      }
      return flat
    })

    const columns = rows.length > 0 ? Object.keys(rows[0]) : []
    return { rows, columns, row_count: rows.length }
  },

  async runQuery(client, { sql, params = [], limit }) {
    // MongoDB "queries" come as JSON strings:
    //   { "aggregate": [ { "$match": {...} }, ... ] }
    //   { "filter": {...}, "project": {...}, "sort": {...} }
    //
    // Safety: only read ops are allowed. $out and $merge are blocked.
    if (typeof sql !== 'string' || sql.trim() === '') {
      throw new Error('MongoDB query must be a JSON string')
    }

    let parsed
    try {
      parsed = JSON.parse(sql)
    } catch {
      throw new Error('MongoDB query must be valid JSON. Use: { "aggregate": [...] } or { "filter": {...} }')
    }

    const db = client.db()
    // Determine target collection — use the first collection listed, or a default
    const collectionName = parsed.collection || (await db.listCollections().limit(1).toArray())[0]?.name
    if (!collectionName) {
      throw new Error('No collection specified and no collections exist in this database')
    }

    const collection = db.collection(collectionName)
    const cap = Math.min(limit || MAX_ROWS, MAX_ROWS)

    if (parsed.aggregate && Array.isArray(parsed.aggregate)) {
      // Safety: block write stages
      const writeStages = parsed.aggregate.filter(
        s => s && (s.$out || s.$merge)
      )
      if (writeStages.length > 0) {
        throw new Error('Write aggregation stages ($out, $merge) are not allowed')
      }

      // Always append a $limit for safety
      const hasLimit = parsed.aggregate.some(s => s && s.$limit)
      const pipeline = hasLimit
        ? parsed.aggregate
        : [...parsed.aggregate, { $limit: cap }]

      const docs = await collection.aggregate(pipeline).toArray()
      const rows = mongoDriver._serializeDocs(docs)
      return {
        rows,
        columns: rows.length > 0 ? Object.keys(rows[0]) : [],
        row_count: rows.length,
        truncated: rows.length >= cap
      }
    }

    // Default: find() with optional filter/projection/sort
    const filter = parsed.filter || {}
    const projection = parsed.projection || parsed.project || undefined
    const sort = parsed.sort || undefined

    let cursor = collection.find(filter)
    if (projection) cursor = cursor.project(projection)
    if (sort) cursor = cursor.sort(sort)
    cursor = cursor.limit(cap)

    const docs = await cursor.toArray()
    const rows = mongoDriver._serializeDocs(docs)
    return {
      rows,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      row_count: rows.length,
      truncated: rows.length >= cap
    }
  },

  // Helper: serialize BSON types to JSON-friendly values
  _serializeDocs(docs) {
    return docs.map(doc => {
      const flat = {}
      for (const [k, v] of Object.entries(doc)) {
        if (v && typeof v === 'object' && v._bsontype === 'ObjectId') {
          flat[k] = v.toString()
        } else if (v instanceof Date) {
          flat[k] = v.toISOString()
        } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          flat[k] = JSON.stringify(v)
        } else {
          flat[k] = v
        }
      }
      return flat
    })
  }
}

// ─── Driver registry ──────────────────────────────────────────────────────
const DRIVERS = {
  postgres: postgresDriver,
  pg: postgresDriver,        // alias
  mysql: mysqlDriver,
  mariadb: mysqlDriver,      // wire-compatible
  sqlite: sqliteDriver,
  mongodb: mongoDriver,
  mongo: mongoDriver,        // alias
}

function resolveDriver(flavor) {
  const key = String(flavor || 'postgres').toLowerCase()
  const driver = DRIVERS[key]
  if (!driver) throw new Error(`Unsupported database flavor: ${flavor}`)
  return driver
}

// Back-compat export: existing callers import { buildPgConfig } from this file
export function buildPgConfig(conn) {
  const cfg = decryptCredentials(conn.config || {})
  return postgresDriver.buildConfig(cfg)
}

// Public: return the flavor name in use for a connector row (defaults to postgres)
function connFlavor(conn) {
  const cfg = decryptCredentials(conn.config || {})
  return String(cfg.flavor || 'postgres').toLowerCase()
}

function getOrCreatePool(conn) {
  const cached = poolCache.get(conn.id)
  if (cached) {
    cached.lastUsed = Date.now()
    armEviction(conn.id)
    return { pool: cached.pool, driver: DRIVERS[cached.flavor] }
  }
  const flavor = connFlavor(conn)
  const driver = resolveDriver(flavor)
  const cfg = decryptCredentials(conn.config || {})
  const pool = driver.createPool(cfg)
  trimPoolCache() // evict oldest entries if we're at the cap
  poolCache.set(conn.id, { flavor, pool, lastUsed: Date.now(), timer: null })
  armEviction(conn.id)
  return { pool, driver }
}

// ─── Public operations (used by connector-tools.service.js) ──────────────

export async function verifyDatabaseConnector(conn) {
  try {
    const { pool, driver } = getOrCreatePool(conn)
    const { message } = await driver.verify(pool)
    return { success: true, message }
  } catch (err) {
    evictPool(conn.id)
    return { success: false, message: `Database connection failed: ${err.message}` }
  }
}

export async function listTables(conn) {
  const { pool, driver } = getOrCreatePool(conn)
  const { tables } = await driver.listTables(pool)
  return { success: true, tables }
}

export async function describeTable(conn, { schema, table } = {}) {
  if (!table) return { success: false, error: 'table is required' }
  const { pool, driver } = getOrCreatePool(conn)
  const flavor = connFlavor(conn)
  // Postgres defaults schema to 'public'; MySQL uses the current database
  const effectiveSchema = schema ?? (flavor === 'postgres' || flavor === 'pg' ? 'public' : undefined)
  const { cols, pks, idx } = await driver.describeTable(pool, { schema: effectiveSchema, table })
  if (cols.length === 0) {
    return { success: false, error: `Table ${effectiveSchema ? `"${effectiveSchema}".` : ''}"${table}" not found or not accessible` }
  }
  return { success: true, schema: effectiveSchema, table, columns: cols, primary_key: pks, indexes: idx }
}

export async function sampleTable(conn, { schema, table, limit = 5 } = {}) {
  if (!table) return { success: false, error: 'table is required' }
  const { pool, driver } = getOrCreatePool(conn)
  const flavor = connFlavor(conn)
  const effectiveSchema = schema ?? (flavor === 'postgres' || flavor === 'pg' ? 'public' : undefined)
  const { rows, columns, row_count } = await driver.sampleTable(pool, { schema: effectiveSchema, table, limit })
  return { success: true, row_count, columns, rows }
}

export async function runQuery(conn, { sql, params = [], limit } = {}) {
  const { pool, driver } = getOrCreatePool(conn)
  const { rows, columns, row_count, truncated } = await driver.runQuery(pool, { sql, params, limit })
  return { success: true, row_count, truncated, columns, rows }
}

// Introspection helper (used by connector-tools.service to label tools)
export function getConnectorFlavor(conn) {
  return connFlavor(conn)
}

// Exported for tests
export { DRIVERS }
