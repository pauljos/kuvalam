// apps/api/src/services/graph-db-importer.service.js
// "Import from Database" — scans database schema, reads rows, and
// auto-populates a Neo4j knowledge graph with entities (tables→labels,
// rows→nodes, foreign keys→relationships). Zero-config for the user.
// Supports PostgreSQL, MySQL/MariaDB, Snowflake, Redshift, Oracle + internal Postgres.

import pg from 'pg'
import mysql from 'mysql2/promise'
import { query } from '../db/pool.js'
import { decryptCredentials } from './crypto.service.js'

// ─── DB Source Discovery ───────────────────────────────────────────────────

/**
 * Returns all available database sources for a tenant:
 * - The internal database (always available as source "internal")
 * - Any ACTIVE database-type tool_connections (PostgreSQL, vector-db, etc.)
 */
export async function getDBSources(tenantId) {
  const sources = [
    {
      id: 'internal',
      name: 'Internal Database (PostgreSQL)',
      type: 'internal',
      flavor: 'postgres',
    },
  ]

  // Fetch ALL database-type connectors — SQL Database, Snowflake, Redshift, Oracle
  const DB_TOOL_IDS = ['database', 'warehouse', 'postgres', 'mysql', 'snowflake', 'redshift', 'oracle']
  const { rows: connectors } = await query(
    `SELECT id, name, tool_id, config, deployment_type
     FROM tool_connections
     WHERE tenant_id = $1
       AND status = 'ACTIVE'
       AND tool_id = ANY($2)
     ORDER BY created_at DESC`,
    [tenantId, DB_TOOL_IDS]
  )

  for (const conn of connectors) {
    const cfg = decryptCredentials(conn.config || {})
    // Resolve flavor: 'database' connector uses cfg.flavor, others use tool_id
    const flavor = cfg.flavor || conn.tool_id
    sources.push({
      id: conn.id,
      name: conn.name || `${cfg.host || cfg.account || 'unknown'}`,
      type: conn.tool_id,
      flavor,
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      deploymentType: conn.deployment_type,
    })
  }

  return sources
}

/**
 * Determine the effective DB flavor from a connector's config and tool_id.
 * Returns one of: postgres, mysql, mariadb, snowflake, redshift, oracle
 */
function resolveFlavor(conn, cfg) {
  if (cfg.flavor) return cfg.flavor.toLowerCase()
  // tool_id-based fallback — connectors that don't use a 'flavor' field
  if (conn.tool_id === 'snowflake') return 'snowflake'
  if (conn.tool_id === 'redshift') return 'redshift'
  if (conn.tool_id === 'oracle') return 'oracle'
  return 'postgres'
}

/**
 * Resolve a DB source to a uniform query executor. Returns { query, pool }.
 * Handles PostgreSQL, MySQL/MariaDB, Snowflake, Redshift, and Oracle.
 */
async function resolveDBSource(tenantId, connectionId) {
  if (!connectionId || connectionId === 'internal') {
    return { query, pool: null, flavor: 'postgres' }
  }

  const { rows: [conn] } = await query(
    `SELECT id, name, tool_id, config FROM tool_connections
     WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'`,
    [connectionId, tenantId]
  )
  if (!conn) throw Object.assign(new Error('Database connection not found or not active'), { statusCode: 404 })

  const cfg = decryptCredentials(conn.config || {})
  const flavor = resolveFlavor(conn, cfg)
  const name = conn.name || flavor

  // ── PostgreSQL / Redshift (Redshift is Postgres-wire-compatible) ──────
  if (flavor === 'postgres' || flavor === 'pgvector' || flavor === 'redshift') {
    const pool = new pg.Pool({
      host: cfg.host || 'localhost',
      port: parseInt(cfg.port || (flavor === 'redshift' ? '5439' : '5432')),
      user: cfg.user || cfg.username,
      password: cfg.password,
      database: cfg.database || 'postgres',
      ssl: cfg.ssl === true || cfg.ssl === 'true' || cfg.ssl === 'require'
        ? { rejectUnauthorized: false } : false,
      max: 3,
      idleTimeoutMillis: 30_000,
    })
    try {
      const client = await pool.connect()
      client.release()
    } catch (e) {
      await pool.end().catch(() => {})
      throw Object.assign(new Error(`Failed to connect to "${name}": ${e.message}`), { statusCode: 400 })
    }
    return {
      query: (text, params) => pool.query(text, params),
      pool,
      flavor,
    }
  }

  // ── MySQL / MariaDB ───────────────────────────────────────────────────
  if (flavor === 'mysql' || flavor === 'mariadb') {
    const pool = mysql.createPool({
      host: cfg.host || 'localhost',
      port: parseInt(cfg.port || '3306'),
      user: cfg.user || cfg.username || 'root',
      password: cfg.password || '',
      database: cfg.database || 'mysql',
      ssl: cfg.ssl === true || cfg.ssl === 'true' || cfg.ssl === 'require'
        ? { rejectUnauthorized: false } : undefined,
      connectionLimit: 3,
      waitForConnections: true,
    })
    try {
      const conn2 = await pool.getConnection()
      conn2.release()
    } catch (e) {
      await pool.end().catch(() => {})
      throw Object.assign(new Error(`Failed to connect to "${name}": ${e.message}`), { statusCode: 400 })
    }
    return {
      query: async (text, params) => {
        // mysql2 auto-escapes ? placeholders, so convert $1,$2 to ?
        const mysqlText = text.replace(/\$(\d+)/g, () => '?')
        const [rows] = await pool.query(mysqlText, params)
        return { rows }
      },
      pool,
      flavor,
    }
  }

  // ── Snowflake ─────────────────────────────────────────────────────────
  if (flavor === 'snowflake') {
    try {
      const snowflake = await import('snowflake-sdk')
      const account = cfg.account || ''
      const username = cfg.username || cfg.user || ''
      const password = cfg.password || ''
      const warehouse = cfg.warehouse || ''
      const database = cfg.database || ''
      const schema = cfg.schema || 'PUBLIC'

      const connection = snowflake.createConnection({
        account,
        username,
        password,
        warehouse,
        database,
        schema,
      })

      await new Promise((resolve, reject) => {
        connection.connect((err, conn) => {
          if (err) reject(err)
          else resolve(conn)
        })
      })

      const sfQuery = (text, params) => new Promise((resolve, reject) => {
        // Convert $1,$2 to :1,:2 bind style
        let idx = 0
        const sfText = text.replace(/\$(\d+)/g, (_, n) => `:${n}`)
        const binds = (params || []).reduce((acc, v, i) => {
          acc[(i + 1).toString()] = v
          return acc
        }, {})
        connection.execute({
          sqlText: sfText,
          binds,
          complete: (err, stmt, rows) => {
            if (err) reject(err)
            else resolve({ rows: rows || [] })
          },
        })
      })

      return {
        query: sfQuery,
        pool: {
          end: () => new Promise(resolve => {
            connection.destroy((err) => resolve())
          }),
        },
        flavor,
      }
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND' || e.message?.includes('Cannot find')) {
        throw Object.assign(new Error('Snowflake SDK not installed. Run: npm install snowflake-sdk'), { statusCode: 500 })
      }
      throw Object.assign(new Error(`Failed to connect to "${name}": ${e.message}`), { statusCode: 400 })
    }
  }

  // ── Oracle ────────────────────────────────────────────────────────────
  if (flavor === 'oracle') {
    try {
      const oracledb = await import('oracledb')
      const host = cfg.host || 'localhost'
      const port = cfg.port || '1521'
      const service = cfg.service || cfg.database || 'ORCL'
      const user = cfg.user || cfg.username || ''
      const password = cfg.password || ''

      const connStr = `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=(SERVICE_NAME=${service})))`
      const connection = await oracledb.getConnection({
        user,
        password,
        connectString: connStr,
      })

      return {
        query: async (text, params) => {
          // Convert $1,$2 to :1,:2
          const oraText = text.replace(/\$(\d+)/g, (_, n) => `:${n}`)
          const binds = (params || []).reduce((acc, v, i) => {
            acc[(i + 1).toString()] = v
            return acc
          }, {})
          const result = await connection.execute(oraText, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT })
          return { rows: result.rows || [] }
        },
        pool: {
          end: () => connection.close(),
        },
        flavor,
      }
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND' || e.message?.includes('Cannot find')) {
        throw Object.assign(new Error('Oracle driver not installed. Run: npm install oracledb'), { statusCode: 500 })
      }
      throw Object.assign(new Error(`Failed to connect to "${name}": ${e.message}`), { statusCode: 400 })
    }
  }

  throw Object.assign(new Error(`Unsupported database flavor: "${flavor}"`), { statusCode: 400 })
}

// ─── Schema Discovery ──────────────────────────────────────────────────────

/**
 * Returns the system schema exclusion list for a given DB flavor.
 * All common DBs support information_schema (ANSI SQL), but each has
 * its own set of internal/system schemas that should be hidden.
 */
function getSystemSchemas(flavor) {
  switch (flavor) {
    case 'mysql':
    case 'mariadb':
      return ['information_schema', 'mysql', 'performance_schema', 'sys']
    case 'snowflake':
      return ['INFORMATION_SCHEMA']
    case 'oracle':
      // Oracle ALL_TABLES excludes system schemas by default;
      // additional filters for common internal schemas
      return ['SYS', 'SYSTEM', 'CTXSYS', 'MDSYS', 'OLAPSYS', 'XDB', 'ORDSYS', 'DBSNMP', 'WMSYS']
    default: // postgres, redshift
      return ['pg_catalog', 'information_schema']
  }
}

/**
 * Build a parameterised NOT IN clause for the schema exclusion.
 * Uses the driver's native placeholder style ($1,$2… — converted by query wrapper)
 */
function schemaExclusionSQL(flavor) {
  const schemas = getSystemSchemas(flavor)
  return schemas.map((_, i) => `$${i + 1}`).join(', ')
}

/**
 * Scan the database's information_schema and return tables, columns,
 * and foreign keys. Excludes system schemas.
 * Works across PostgreSQL, MySQL/MariaDB, Snowflake, Redshift, and Oracle.
 *
 * @param {string} tenantId
 * @param {string} [connectionId] - Optional external DB connection ID. Uses internal DB if omitted.
 */
export async function discoverDBSchema(tenantId, connectionId) {
  const db = await resolveDBSource(tenantId, connectionId)
  const flavor = db.flavor || 'postgres'
  const sysSchemas = getSystemSchemas(flavor)
  const isOracle = flavor === 'oracle'
  const isSnowflake = flavor === 'snowflake'

  try {
    // ── Tables ─────────────────────────────────────────────────────────
    let tables = []
    if (isOracle) {
      // Oracle uses ALL_TABLES view (different column names)
      const { rows } = await db.query(
        `SELECT OWNER AS table_schema, TABLE_NAME AS table_name
         FROM ALL_TABLES
         WHERE OWNER NOT IN (${sysSchemas.map((_, i) => `$${i + 1}`).join(', ')})
         ORDER BY OWNER, TABLE_NAME`,
        sysSchemas
      )
      tables = rows
    } else if (isSnowflake) {
      // Snowflake INFORMATION_SCHEMA uses UPPER_CASE identifiers
      const { rows } = await db.query(
        `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA NOT IN (${sysSchemas.map((_, i) => `$${i + 1}`).join(', ')})
           AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_SCHEMA, TABLE_NAME`,
        sysSchemas
      )
      tables = rows.map(r => ({
        table_schema: r.TABLE_SCHEMA || r.table_schema,
        table_name: r.TABLE_NAME || r.table_name,
      }))
    } else {
      // PostgreSQL / MySQL / Redshift — standard information_schema
      const { rows } = await db.query(
        `SELECT table_schema, table_name
         FROM information_schema.tables
         WHERE table_schema NOT IN (${sysSchemas.map((_, i) => `$${i + 1}`).join(', ')})
           AND table_type = 'BASE TABLE'
         ORDER BY table_schema, table_name`,
        sysSchemas
      )
      tables = rows
    }

    // ── Columns ────────────────────────────────────────────────────────
    let columns = []
    if (isOracle) {
      const { rows } = await db.query(
        `SELECT OWNER AS table_schema, TABLE_NAME AS table_name,
                COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
                NULLABLE AS is_nullable, COLUMN_ID AS ordinal_position
         FROM ALL_TAB_COLUMNS
         WHERE OWNER NOT IN (${sysSchemas.map((_, i) => `$${i + 1}`).join(', ')})
         ORDER BY OWNER, TABLE_NAME, COLUMN_ID`,
        sysSchemas
      )
      columns = rows.map(r => ({
        table_schema: r.TABLE_SCHEMA || r.table_schema,
        table_name: r.TABLE_NAME || r.table_name,
        column_name: r.COLUMN_NAME || r.column_name,
        data_type: r.DATA_TYPE || r.data_type,
        is_nullable: r.IS_NULLABLE || r.is_nullable,
        ordinal_position: r.ORDINAL_POSITION || r.ordinal_position,
      }))
    } else if (isSnowflake) {
      const { rows } = await db.query(
        `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name,
                COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
                IS_NULLABLE AS is_nullable, ORDINAL_POSITION AS ordinal_position
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA NOT IN (${sysSchemas.map((_, i) => `$${i + 1}`).join(', ')})
         ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
        sysSchemas
      )
      columns = rows.map(r => ({
        table_schema: r.TABLE_SCHEMA || r.table_schema,
        table_name: r.TABLE_NAME || r.table_name,
        column_name: r.COLUMN_NAME || r.column_name,
        data_type: r.DATA_TYPE || r.data_type,
        is_nullable: r.IS_NULLABLE || r.is_nullable,
        ordinal_position: r.ORDINAL_POSITION || r.ordinal_position,
      }))
    } else {
      const { rows } = await db.query(
        `SELECT table_schema, table_name, column_name, data_type, is_nullable,
                ordinal_position
         FROM information_schema.columns
         WHERE table_schema NOT IN (${sysSchemas.map((_, i) => `$${i + 1}`).join(', ')})
         ORDER BY table_schema, table_name, ordinal_position`,
        sysSchemas
      )
      columns = rows
    }

    // ── Foreign Keys ───────────────────────────────────────────────────
    let foreignKeys = []
    if (isOracle) {
      // Oracle FK query via ALL_CONSTRAINTS + ALL_CONS_COLUMNS
      try {
        const { rows } = await db.query(
          `SELECT a.OWNER AS fk_schema, a.TABLE_NAME AS fk_table,
                  b.COLUMN_NAME AS fk_column,
                  c.OWNER AS pk_schema, c.TABLE_NAME AS pk_table,
                  d.COLUMN_NAME AS pk_column
           FROM ALL_CONSTRAINTS a
           JOIN ALL_CONS_COLUMNS b ON a.CONSTRAINT_NAME = b.CONSTRAINT_NAME AND a.OWNER = b.OWNER
           JOIN ALL_CONSTRAINTS c ON a.R_CONSTRAINT_NAME = c.CONSTRAINT_NAME AND a.R_OWNER = c.OWNER
           JOIN ALL_CONS_COLUMNS d ON c.CONSTRAINT_NAME = d.CONSTRAINT_NAME AND c.OWNER = d.OWNER
           WHERE a.CONSTRAINT_TYPE = 'R'
             AND a.OWNER NOT IN (${sysSchemas.map((_, i) => `$${i + 1}`).join(', ')})
           ORDER BY a.OWNER, a.TABLE_NAME`,
          sysSchemas
        )
        foreignKeys = rows.map(r => ({
          fk_schema: r.FK_SCHEMA || r.fk_schema,
          fk_table: r.FK_TABLE || r.fk_table,
          fk_column: r.FK_COLUMN || r.fk_column,
          pk_schema: r.PK_SCHEMA || r.pk_schema,
          pk_table: r.PK_TABLE || r.pk_table,
          pk_column: r.PK_COLUMN || r.pk_column,
        }))
      } catch { /* FK discovery is best-effort */ }
    } else if (isSnowflake) {
      try {
        const { rows } = await db.query(
          `SELECT tc.TABLE_SCHEMA AS fk_schema, tc.TABLE_NAME AS fk_table,
                  kcu.COLUMN_NAME AS fk_column,
                  ccu.TABLE_SCHEMA AS pk_schema, ccu.TABLE_NAME AS pk_table,
                  ccu.COLUMN_NAME AS pk_column
           FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
             ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
             AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
           JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
             ON ccu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
             AND ccu.TABLE_SCHEMA = tc.TABLE_SCHEMA
           WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
             AND tc.TABLE_SCHEMA NOT IN (${sysSchemas.map((_, i) => `$${i + 1}`).join(', ')})
           ORDER BY tc.TABLE_SCHEMA, tc.TABLE_NAME`,
          sysSchemas
        )
        foreignKeys = rows.map(r => ({
          fk_schema: r.FK_SCHEMA || r.fk_schema,
          fk_table: r.FK_TABLE || r.fk_table,
          fk_column: r.FK_COLUMN || r.fk_column,
          pk_schema: r.PK_SCHEMA || r.pk_schema,
          pk_table: r.PK_TABLE || r.pk_table,
          pk_column: r.PK_COLUMN || r.pk_column,
        }))
      } catch { /* FK discovery is best-effort */ }
    } else {
      try {
        const { rows } = await db.query(
          `SELECT
             tc.table_schema  AS fk_schema,
             tc.table_name    AS fk_table,
             kcu.column_name  AS fk_column,
             ccu.table_schema AS pk_schema,
             ccu.table_name   AS pk_table,
             ccu.column_name  AS pk_column
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name
             AND ccu.table_schema = tc.table_schema
           WHERE tc.constraint_type = 'FOREIGN KEY'
             AND tc.table_schema NOT IN (${sysSchemas.map((_, i) => `$${i + 1}`).join(', ')})
           ORDER BY tc.table_schema, tc.table_name`,
          sysSchemas
        )
        foreignKeys = rows
      } catch { /* FK discovery is best-effort */ }
    }

    // ── Group columns & FKs by table ───────────────────────────────────
    const tableMap = new Map()
    for (const t of tables) {
      const key = `${t.table_schema}.${t.table_name}`
      tableMap.set(key, {
        schema: t.table_schema,
        name: t.table_name,
        columns: [],
        foreignKeys: [],
        rowCount: 0,
      })
    }
    for (const c of columns) {
      const key = `${c.table_schema}.${c.table_name}`
      const tbl = tableMap.get(key)
      if (tbl) tbl.columns.push({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === 'YES' || c.is_nullable === 'Y',
        position: c.ordinal_position,
      })
    }
    for (const fk of foreignKeys) {
      const key = `${fk.fk_schema}.${fk.fk_table}`
      const tbl = tableMap.get(key)
      if (tbl) tbl.foreignKeys.push({
        column: fk.fk_column,
        refSchema: fk.pk_schema,
        refTable: fk.pk_table,
        refColumn: fk.pk_column,
      })
    }

    // ── Row counts (flavor-appropriate) ────────────────────────────────
    if (flavor === 'postgres' || flavor === 'pgvector' || flavor === 'redshift') {
      // PostgreSQL / Redshift: fast approximate via pg_class
      for (const [key, tbl] of tableMap) {
        try {
          const { rows: [r] } = await db.query(
            `SELECT reltuples::bigint AS estimate FROM pg_class
             WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)`,
            [tbl.name, tbl.schema]
          )
          tbl.rowCount = r ? parseInt(r.estimate) : 0
        } catch { tbl.rowCount = 0 }
      }
    } else if (flavor === 'mysql' || flavor === 'mariadb') {
      // MySQL: approximate from information_schema statistics
      for (const [key, tbl] of tableMap) {
        try {
          const { rows: [r] } = await db.query(
            `SELECT TABLE_ROWS AS estimate FROM information_schema.tables
             WHERE table_schema = $1 AND table_name = $2`,
            [tbl.schema, tbl.name]
          )
          tbl.rowCount = r && r.estimate ? parseInt(r.estimate) : 0
        } catch { tbl.rowCount = 0 }
      }
    } else if (isSnowflake) {
      // Snowflake: row count from information_schema
      for (const [key, tbl] of tableMap) {
        try {
          const { rows: [r] } = await db.query(
            `SELECT ROW_COUNT AS estimate FROM INFORMATION_SCHEMA.TABLES
             WHERE TABLE_SCHEMA = $1 AND TABLE_NAME = $2`,
            [tbl.schema, tbl.name]
          )
          tbl.rowCount = r && r.ESTIMATE ? parseInt(r.ESTIMATE) : 0
        } catch { tbl.rowCount = 0 }
      }
    } else if (isOracle) {
      // Oracle: NUM_ROWS from ALL_TABLES (requires stats gathering)
      for (const [key, tbl] of tableMap) {
        try {
          const { rows: [r] } = await db.query(
            `SELECT NUM_ROWS AS estimate FROM ALL_TABLES
             WHERE OWNER = $1 AND TABLE_NAME = $2`,
            [tbl.schema, tbl.name]
          )
          tbl.rowCount = r && r.ESTIMATE ? parseInt(r.ESTIMATE) : 0
        } catch { tbl.rowCount = 0 }
      }
    }

    return {
      tables: Array.from(tableMap.values()),
      totalTables: tables.length,
      totalColumns: columns.length,
      totalForeignKeys: foreignKeys.length,
    }
  } finally {
    // Clean up external pool if one was created
    if (db.pool) {
      await db.pool.end().catch(() => {})
    }
  }
}

// ─── Neo4j Query Execution ─────────────────────────────────────────────────

/**
 * Execute a Cypher query against Neo4j via HTTP API.
 */
async function neo4jQuery({ host, httpPort, username, password, database }, cypher, params = {}) {
  const httpUrl = `http://${host}:${httpPort || 7474}`
  const auth = Buffer.from(`${username}:${password}`).toString('base64')

  const resp = await fetch(`${httpUrl}/db/${database}/tx/commit`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ statements: [{ statement: cypher, parameters: params }] }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Neo4j returned ${resp.status}: ${body.slice(0, 300)}`)
  }

  const json = await resp.json()
  if (json.errors?.length) {
    throw new Error(`Neo4j error: ${json.errors[0].message || json.errors[0].code}`)
  }

  return json.results?.[0] || { columns: [], data: [] }
}

// ─── Resolve Neo4j Credentials ─────────────────────────────────────────────

/**
 * Get Neo4j connection details for a tenant from the knowledge-graph
 * tool_connection and the knowledge_graphs table.
 */
export async function resolveNeo4jConfig(tenantId, graphId) {
  // Get the graph record
  const { rows: [graph] } = await query(
    `SELECT * FROM knowledge_graphs WHERE id = $1 AND tenant_id = $2`,
    [graphId, tenantId]
  )
  if (!graph) throw Object.assign(new Error('Knowledge graph not found'), { statusCode: 404 })

  // Get the Neo4j tool_connection for credentials
  const { rows: [conn] } = await query(
    `SELECT config FROM tool_connections
     WHERE tenant_id = $1 AND tool_id = 'knowledge-graph' AND status = 'ACTIVE'
     LIMIT 1`,
    [tenantId]
  )
  if (!conn) throw Object.assign(new Error('No active Neo4j backend found. Go to Settings → Knowledge Backends to set it up.'), { statusCode: 400 })

  const cfg = decryptCredentials(conn.config || {})

  const host = graph.host || cfg.host || process.env.NEO4J_HOST || ''
  if (!host) throw Object.assign(new Error('No Neo4j host configured. Set NEO4J_HOST env var or provide a host in graph settings.'), { statusCode: 400 })
  return {
    host,
    httpPort: graph.http_port || cfg.httpPort || process.env.NEO4J_HTTP_PORT || '7474',
    boltPort: graph.bolt_port || cfg.boltPort || process.env.NEO4J_BOLT_PORT || '7687',
    username: graph.username || cfg.username || process.env.NEO4J_USER || 'neo4j',
    password: cfg.password || process.env.NEO4J_PASSWORD || '',
    database: graph.database_name || cfg.database || process.env.NEO4J_DATABASE || 'neo4j',
  }
}

// ─── Main Import Orchestrator ──────────────────────────────────────────────

/**
 * Import PostgreSQL tables into a Neo4j knowledge graph.
 *
 * For each selected table:
 * 1. Reads all rows (with optional LIMIT)
 * 2. Creates Neo4j nodes with label = table name
 * 3. Creates relationships for each foreign key found in the data
 *
 * @returns { tables: number, nodes: number, relationships: number, errors: string[] }
 */
export async function importDBToGraph(tenantId, graphId, { tables: selectedTables, limit = 500, connectionId } = {}) {
  const neo4j = await resolveNeo4jConfig(tenantId, graphId)
  const schema = await discoverDBSchema(tenantId, connectionId)
  const db = await resolveDBSource(tenantId, connectionId)

  try {
    // Filter to selected tables (or all if not specified)
    const toImport = selectedTables && selectedTables.length > 0
      ? schema.tables.filter(t => selectedTables.includes(`${t.schema}.${t.name}`) || selectedTables.includes(t.name))
      : schema.tables

    if (toImport.length === 0) {
      return { tables: 0, nodes: 0, relationships: 0, errors: ['No matching tables found'] }
    }

    const errors = []
    let totalNodes = 0
    let totalRelationships = 0
    let tablesProcessed = 0

  // Ensure uniqueness constraint per label to enable MERGE
  // We create a composite index on (name, _source_table) so the same
  // entity name from different source tables doesn't collide.
  for (const tbl of toImport) {
    const label = safeLabel(tbl.name)
    try {
      // Read rows from database — use flavor-appropriate quoting
      const flavor = db.flavor || 'postgres'
      const isMySQL = flavor === 'mysql' || flavor === 'mariadb'
      const quoteLeft = isMySQL ? '`' : '"'
      const quoteRight = isMySQL ? '`' : '"'
      const pkCol = tbl.columns.find(c => c.name === 'id') || tbl.columns[0]
      let rows
      try {
        const result = await db.query(
          `SELECT * FROM ${quoteLeft}${tbl.schema}${quoteRight}.${quoteLeft}${tbl.name}${quoteRight} LIMIT $1`,
          [limit]
        )
        rows = result.rows
      } catch (e) {
        errors.push(`${tbl.name}: query failed — ${e.message}`)
        continue
      }

      if (rows.length === 0) {
        tablesProcessed++
        continue
      }

      // Ensure constraint for MERGE
      await neo4jQuery(neo4j,
        `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE (n._source_id, n._source_table) IS UNIQUE`
      ).catch(() => {}) // constraint may already exist from a different label path

      // Import nodes in batches
      const BATCH = 100
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH)

        const params = {}
        const unwinds = batch.map((row, idx) => {
          // Build properties, skipping nulls and very large values
          const props = {}
          for (const col of tbl.columns) {
            const val = row[col.name]
            if (val === null || val === undefined) continue
            if (typeof val === 'string' && val.length > 5000) continue // skip huge text blobs
            if (Buffer.isBuffer(val)) continue
            props[col.name] = val
          }

          // Use the PK column value as _source_id, falling back to row index
          const sourceId = row[pkCol.name] != null ? String(row[pkCol.name]) : `${tbl.name}_row_${i + idx}`

          return {
            _source_id: sourceId,
            _source_table: tbl.name,
            props,
          }
        })

        params.unwinds = unwinds

        // Tag every imported node with _source_graph for tenant isolation
        const safeGraphId = String(graphId).replace(/[^a-zA-Z0-9_]/g, '_')
        await neo4jQuery(neo4j, `
          UNWIND $unwinds AS row
          MERGE (n:${label} {_source_id: row._source_id, _source_table: row._source_table})
          SET n += row.props
          SET n._source_graph = $graphId
          SET n.updated_at = datetime()
        `, { ...params, graphId: safeGraphId })

        totalNodes += batch.length
      }

      // Create relationships for foreign keys
      for (const fk of tbl.foreignKeys) {
        const refLabel = safeLabel(fk.refTable)
        const relType = safeLabel(`HAS_${fk.refTable}`.toUpperCase())

        // Only create relationships if the FK column exists in our data
        // and the referenced table is also being imported
        const refTableInScope = toImport.some(t => t.name === fk.refTable)

        if (refTableInScope) {
          // Use single-quoted strings for dynamic property access (Neo4j backticks escape labels, not string literals)
          const colProp = fk.column.replace(/'/g, "\\'")
          const refColProp = fk.refColumn.replace(/'/g, "\\'")
          await neo4jQuery(neo4j, `
            MATCH (a:${label} {_source_table: $srcTable})
            MATCH (b:${refLabel} {_source_table: $refTable})
            WHERE a['${colProp}'] = b['${refColProp}']
               OR toString(a['${colProp}']) = toString(b['${refColProp}'])
            MERGE (a)-[r:${relType}]->(b)
            SET r.updated_at = datetime()
          `, { srcTable: tbl.name, refTable: fk.refTable })

          // Count the relationships created
          const countRes = await neo4jQuery(neo4j, `
            MATCH (a:${label} {_source_table: $srcTable})-[r:${relType}]->(:${refLabel})
            RETURN count(r) AS cnt
          `, { srcTable: tbl.name })
          const relCount = countRes?.data?.[0]?.row?.[0] || 0
          totalRelationships += parseInt(relCount)
        }
      }

      tablesProcessed++
    } catch (e) {
      errors.push(`${tbl.name}: ${e.message}`)
    }
  }

  // Update entity/relationship counts in knowledge_graphs
  try {
    await query(
      `UPDATE knowledge_graphs SET entity_count = $1, relationship_count = $2, updated_at = NOW()
       WHERE id = $3`,
      [totalNodes, totalRelationships, graphId]
    )
  } catch { /* non-critical — counts are cosmetic */ }

  return {
    tables: tablesProcessed,
    nodes: totalNodes,
    relationships: totalRelationships,
    errors: errors.length > 0 ? errors : undefined,
  }
  } finally {
    // Clean up external pool if one was created
    if (db.pool) {
      await db.pool.end().catch(() => {})
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function safeLabel(name) {
  // Neo4j labels must be alphanumeric with underscores; cannot start with number
  let safe = name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+/, '')
  if (/^[0-9]/.test(safe)) safe = 'T_' + safe
  if (!safe) safe = 'Entity'
  // Capitalize first letter for convention
  safe = safe.charAt(0).toUpperCase() + safe.slice(1)
  return safe
}
