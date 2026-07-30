// apps/api/src/services/chat.service.js
import { query } from '../db/pool.js'
import { complete, completeStream } from './llm.service.js'
import { AppError } from '../utils/errors.js'
import { cached } from './cache.service.js'
import { hashKey } from './task-json-repair.js'

export async function createConversation({ tenantId, userId, title, model, provider }) {
  const { rows } = await query(
    `INSERT INTO chat_conversations (tenant_id, user_id, title, model, provider)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [tenantId, userId, title || 'New Chat', model, provider]
  )
  return rows[0]
}

export async function listConversations(tenantId, userId, { limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT c.*,
      (SELECT content FROM chat_messages
       WHERE conversation_id = c.id AND role = 'user'
       ORDER BY created_at DESC LIMIT 1) as last_message_preview
     FROM chat_conversations c
     WHERE c.tenant_id = $1 AND c.user_id = $2
     ORDER BY c.updated_at DESC
     LIMIT $3`,
    [tenantId, userId, limit]
  )
  return rows
}

export async function getConversation(tenantId, conversationId, userId) {
  const { rows } = await query(
    `SELECT * FROM chat_conversations
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [conversationId, tenantId, userId]
  )
  if (rows.length === 0) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
  return rows[0]
}

export async function deleteConversation(tenantId, conversationId, userId) {
  const { rowCount } = await query(
    `DELETE FROM chat_conversations
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [conversationId, tenantId, userId]
  )
  if (rowCount === 0) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
  return true
}

export async function updateConversation(tenantId, conversationId, userId, { title }) {
  const { rows } = await query(
    `UPDATE chat_conversations
     SET title = $1, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3 AND user_id = $4
     RETURNING *`,
    [title, conversationId, tenantId, userId]
  )
  if (rows.length === 0) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
  return rows[0]
}

export async function addMessage({ conversationId, role, content, model, promptTokens = 0, completionTokens = 0 }) {
  const { rows } = await query(
    `INSERT INTO chat_messages (conversation_id, role, content, model, prompt_tokens, completion_tokens)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [conversationId, role, content, model, promptTokens, completionTokens]
  )
  // Update conversation timestamp
  await query(
    `UPDATE chat_conversations SET updated_at = NOW() WHERE id = $1`,
    [conversationId]
  )
  return rows[0]
}

export async function getMessages(conversationId, { limit = 100, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT * FROM chat_messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC
     LIMIT $2 OFFSET $3`,
    [conversationId, limit, offset]
  )
  return rows
}

// ── Lightweight database query (used when chatting with a DB-trained custom model) ──
const MAX_QUERY_ROWS = 200
const MAX_CHAT_TOOL_ITERATIONS = 5

/**
 * Execute a database query against a raw PostgreSQL connection string.
 * Only allows SELECT / WITH … SELECT — all DDL/DML is blocked.
 */
async function _executeDbQueryRaw(dbConnectionString, sql) {
  const pg = await import('pg').then(m => m.default || m)
  const client = new pg.Client(dbConnectionString)
  try {
    await client.connect()

    // Safety: allow only SELECT / WITH...SELECT statements
    const trimmed = sql.trim()
    const upper = trimmed.toUpperCase()
    const isSelect = upper.startsWith('SELECT') || (upper.startsWith('WITH') && /\bSELECT\b/.test(upper))
    if (!isSelect) {
      return { error: 'Only SELECT queries are allowed. DDL/DML is blocked for safety.' }
    }

    // Auto-append LIMIT if not present
    let finalSql = trimmed
    if (!upper.includes('LIMIT')) {
      finalSql = `${trimmed}\nLIMIT ${MAX_QUERY_ROWS}`
    }

    const start = Date.now()
    const result = await client.query(finalSql)
    const elapsed = Date.now() - start

    return {
      columns: result.fields.map(f => f.name),
      row_count: result.rows.length,
      elapsed_ms: elapsed,
      rows: result.rows,
    }
  } catch (err) {
    return { error: `DATABASE QUERY FAILED — DO NOT INVENT OR FABRICATE DATA: ${err.message}. Use listTables to see available tables, then describeTable to check column names, then retry with correct SQL using only real column names.` }
  } finally {
    await client.end().catch(() => {})
  }
}

// Cached wrapper — 60s TTL for SQL results
async function _executeDbQuery(dbConnectionString, sql) {
  const key = `dbsql:${hashKey(dbConnectionString, sql)}`
  return cached(key, () => _executeDbQueryRaw(dbConnectionString, sql), 60)
}

/**
 * Execute a single chat database tool.
 * @param {string} toolName
 * @param {object} args
 * @param {object} options - { connectionString, connectionMap }
 */
async function _executeChatDbTool(toolName, args, options) {
  const { connectionString, connectionMap } = options

  switch (toolName) {
    case 'listDatabases': {
      if (!connectionMap) return { error: 'No multi-database configuration found. This model is connected to a single database.' }
      const dbs = [...connectionMap.entries()].map(([label, cfg]) => ({
        label,
        dbType: cfg.dbType,
      }))
      return { databases: dbs, count: dbs.length }
    }
    case 'useDatabase': {
      if (!args.database) return { error: 'database label is required. Call listDatabases to see available databases.' }
      if (!connectionMap) return { error: 'No multi-database configuration found. This model is connected to a single database.' }
      const target = connectionMap.get(args.database)
      if (!target) {
        const available = [...connectionMap.keys()].join(', ')
        return { error: `Unknown database: "${args.database}". Available: ${available}` }
      }
      return {
        switched: true,
        database: args.database,
        dbType: target.dbType,
        _switchConnection: target.connectionString,  // signal to caller
      }
    }
    case 'listTables': {
      const cacheKey = `dbschema:${hashKey(connectionString)}:listTables`
      return cached(cacheKey, async () => {
        const pg = await import('pg').then(m => m.default || m)
        const client = new pg.Client(connectionString)
        try {
          await client.connect()
          const { rows } = await client.query(
            `SELECT table_schema, table_name FROM information_schema.tables
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
             ORDER BY table_schema, table_name`
          )
          return { tables: rows, count: rows.length }
        } catch (err) {
          return { error: `DATABASE TOOL FAILED — DO NOT FABRICATE DATA: Failed to list tables: ${err.message}. Check the database connection and retry.` }
        } finally {
          await client.end().catch(() => {})
        }
      }, 300)  // 5 min TTL
    }
    case 'describeTable': {
      if (!args.table) return { error: 'table name is required' }
      const schema = args.schema || 'public'
      const cacheKey = `dbschema:${hashKey(connectionString)}:desc:${schema}:${args.table}`
      return cached(cacheKey, async () => {
        const pg = await import('pg').then(m => m.default || m)
        const client = new pg.Client(connectionString)
        try {
          await client.connect()
          const { rows: cols } = await client.query(
            `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
            [schema, args.table]
          )
          // Fetch foreign-key relationships so the model can write JOINs
          let foreignKeys = []
          try {
            const { rows: fks } = await client.query(
              `SELECT
                 kcu.column_name,
                 ccu.table_schema AS foreign_schema,
                 ccu.table_name AS foreign_table,
                 ccu.column_name AS foreign_column
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
               JOIN information_schema.constraint_column_usage ccu
                 ON tc.constraint_name = ccu.constraint_name
                 AND tc.table_schema = ccu.table_schema
               WHERE tc.constraint_type = 'FOREIGN KEY'
                 AND tc.table_schema = $1
                 AND tc.table_name = $2`,
              [schema, args.table]
            )
            foreignKeys = fks
          } catch { /* FK lookup is best-effort */ }
          // Also get referenced-by info (reverse FKs)
          let referencedBy = []
          try {
            const { rows: revs } = await client.query(
              `SELECT
                 kcu.column_name,
                 kcu.table_schema AS source_schema,
                 kcu.table_name AS source_table
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
               JOIN information_schema.constraint_column_usage ccu
                 ON tc.constraint_name = ccu.constraint_name
               WHERE tc.constraint_type = 'FOREIGN KEY'
                 AND ccu.table_schema = $1
                 AND ccu.table_name = $2`,
              [schema, args.table]
            )
            referencedBy = revs
          } catch { /* reverse FK lookup is best-effort */ }
          // Get a sample row
          let sample = null
          try {
            const { rows: r } = await client.query(
              `SELECT * FROM "${schema}"."${args.table}" LIMIT 3`
            )
            sample = r
          } catch { /* ignore sample errors */ }
          return {
            table: `${schema}.${args.table}`,
            columns: cols,
            ...(foreignKeys.length > 0 ? { foreignKeys } : {}),
            ...(referencedBy.length > 0 ? { referencedBy } : {}),
            sample,
          }
        } catch (err) {
          return { error: `DATABASE TOOL FAILED — DO NOT FABRICATE DATA: Failed to describe table: ${err.message}. Check the schema and table name, then retry.` }
        } finally {
          await client.end().catch(() => {})
        }
      }, 300)  // 5 min TTL
    }
    case 'runQuery': {
      const sql = args.sql || args.query
      if (!sql) return { error: 'sql is required (pass as "sql", not "query")' }
      return _executeDbQuery(connectionString, sql)
    }
    default:
      return { error: `Unknown tool: ${toolName}` }
  }
}

// ── Database exploration tool definitions ─────────────────────────────────────
const DB_TOOLS = [
  {
    name: 'listTables',
    description: 'List all tables in the currently active database. ⚠️ You MUST call this FIRST before querying any data — never guess table names.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'describeTable',
    description: 'Get column details, foreign keys, and sample rows for a specific table. ⚠️ You MUST call this BEFORE writing any query — never guess column names.',
    inputSchema: {
      type: 'object',
      required: ['table'],
      properties: {
        table: { type: 'string', description: 'Table name (from listTables output)' },
        schema: { type: 'string', description: 'Schema name (default: public)' },
      },
    },
  },
  {
    name: 'runQuery',
    description: 'Run a SQL SELECT query against the live database. Only SELECT queries are allowed. ⚠️ CRITICAL: You MUST call listTables AND describeTable BEFORE this tool. Only use column names confirmed by describeTable. If this tool returns an error, DO NOT fabricate data — report the error honestly and retry with corrected SQL.',
    inputSchema: {
      type: 'object',
      required: ['sql'],
      properties: {
        sql: { type: 'string', description: 'SQL SELECT query using ONLY table/column names confirmed by describeTable' },
      },
    },
  },
]

// Additional tools for multi-DB scenarios (prepended to DB_TOOLS when active)
const MULTI_DB_TOOLS = [
  {
    name: 'listDatabases',
    description: 'List all available databases in this multi-database setup. Call this FIRST to see which data sources are available and what labels to use with useDatabase.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'useDatabase',
    description: 'Switch the active database connection. Call useDatabase("CRM") before querying the CRM database. Once switched, all subsequent listTables/describeTable/runQuery calls target that database until you switch again.',
    inputSchema: {
      type: 'object',
      required: ['database'],
      properties: {
        database: { type: 'string', description: 'Database label to switch to (exact name from listDatabases output)' },
      },
    },
  },
]

/**
 * Try to extract a JSON tool call from plain text (Ollama fallback).
 * Many smaller models output prose like '{"name":"listTables","arguments":{}}'
 * embedded in a larger response. Returns a tool-call-shaped object or null.
 */
function _tryParseChatToolCall(text) {
  if (!text || typeof text !== 'string') return null
  // Strip markdown code fences and leading/trailing whitespace
  let cleaned = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim()
  // Try to find a top-level JSON object with "name" and "arguments" keys
  const jsonMatch = cleaned.match(/\{[^{}]*"name"\s*:\s*"(listDatabases|useDatabase|listTables|describeTable|runQuery)"[^{}]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.name && parsed.arguments !== undefined) {
        return {
          id: 'chat_fallback_' + Date.now(),
          type: 'function',
          function: {
            name: parsed.name,
            arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments),
          },
        }
      }
    } catch { /* keep scanning */ }
  }
  // Try full-text parse as a last resort
  try {
    const parsed = JSON.parse(cleaned)
    if (parsed.name && parsed.arguments !== undefined) {
      return {
        id: 'chat_fallback_' + Date.now(),
        type: 'function',
        function: {
          name: parsed.name,
          arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments),
        },
      }
    }
  } catch { /* not JSON */ }
  return null
}

export async function streamChatResponse({
  tenantId,
  userId,
  conversationId,
  messages,
  model,
  provider,
  llmConfig,
  knowledgeBaseIds = null,
  graphIds = null,
  onToken,
}) {
  // ── Knowledge Base RAG: search vector DB for relevant context ─────────
  let knowledgeContext = ''
  if (knowledgeBaseIds && knowledgeBaseIds.length > 0) {
    try {
      const { searchKnowledge } = await import('./knowledge.service.js')
      const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')
      if (lastUserMessage) {
        const results = await searchKnowledge({
          tenantId,
          query: lastUserMessage.content,
          knowledgeBaseIds,
          topK: 5,
          threshold: 0.4
        })
        if (results.length > 0) {
          // Truncate each chunk to prevent overwhelming the context window (CSV sheets can be huge)
          const MAX_CHUNK_LEN = 3000
          knowledgeContext = results
            .map((r, i) => {
              const truncated = r.content.length > MAX_CHUNK_LEN
                ? r.content.slice(0, MAX_CHUNK_LEN) + '\n... [truncated]'
                : r.content
              return `[Source ${i + 1} from "${r.documentName || 'document'}" (relevance: ${r.score.toFixed(2)})]\n${truncated}`
            })
            .join('\n\n')
        }
      }
    } catch (err) {
      console.warn('[Chat] Knowledge base search failed:', err.message)
      // Non-fatal — continue without RAG context
    }
  }
  // ── Knowledge Graph search: query Neo4j for relevant entities ─────────
  let graphContext = ''
  if (graphIds && graphIds.length > 0) {
    try {
      const { resolveNeo4jConfig } = await import('./graph-db-importer.service.js')
      const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')
      if (lastUserMessage) {
        const words = lastUserMessage.content.split(/\s+/).filter(w => w.length > 3).slice(0, 5)
        const allEntities = []
        for (const graphId of graphIds) {
          try {
            const neo4j = await resolveNeo4jConfig(tenantId, graphId)
            const auth = Buffer.from(`${neo4j.username}:${neo4j.password}`).toString('base64')
            const httpUrl = `http://${neo4j.host}:${neo4j.httpPort}`
            const runCypher = async (statement, params = {}) => {
              const resp = await fetch(`${httpUrl}/db/${neo4j.database}/tx/commit`, {
                method: 'POST',
                headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ statements: [{ statement, parameters: params }] }),
                signal: AbortSignal.timeout(10_000),
              })
              if (!resp.ok) return []
              const json = await resp.json()
              return json.results?.[0]?.data || []
            }
            // Crunch graphId to a safe string for Cypher (UUIDs may contain dashes)
            const safeGraphId = String(graphId).replace(/[^a-zA-Z0-9_]/g, '_')
            // Try keyword-based search first, with tenant-scoped _source_graph filter
            let rows = []
            if (words.length > 0) {
              const keywordCypher = `MATCH (n {_source_graph: $graphId}) WHERE n.name IS NOT NULL AND (${words.map((_, i) => `toLower(n.name) CONTAINS toLower($word${i})`).join(' OR ')}) OPTIONAL MATCH (n)-[r]->(m) WHERE m.name IS NOT NULL RETURN n.name AS entity, labels(n) AS entity_type, collect(DISTINCT { type: type(r), target: m.name, target_type: labels(m) }) AS relationships LIMIT 10`
              const params = { graphId: safeGraphId, ...Object.fromEntries(words.map((w, i) => [`word${i}`, w])) }
              rows = await runCypher(keywordCypher, params)
            }
            // Fallback: if keyword search found nothing, get a sample of all entities scoped to this graph
            if (rows.length === 0) {
              rows = await runCypher(
                `MATCH (n {_source_graph: $graphId}) WHERE n.name IS NOT NULL OPTIONAL MATCH (n)-[r]->(m) WHERE m.name IS NOT NULL RETURN n.name AS entity, labels(n) AS entity_type, collect(DISTINCT { type: type(r), target: m.name, target_type: labels(m) }) AS relationships LIMIT 30`,
                { graphId: safeGraphId }
              )
            }
            for (const row of rows) {
              const entity = row.row[0]
              const etype = (row.row[1] || []).join(', ')
              const rels = (row.row[2] || []).filter(r => r.type).map(r => `  → ${r.type} → ${r.target} (${(r.target_type || []).join(', ')})`).join('\n')
              allEntities.push(`• ${entity} [${etype}]${rels ? '\n' + rels : ''}`)
            }
          } catch { /* skip individual graph failures */ }
        }
        if (allEntities.length > 0) {
          graphContext = `KNOWLEDGE GRAPH (entities & relationships):\n${allEntities.join('\n\n')}`
        }
      }
    } catch (err) {
      console.warn('[Chat] Graph search failed:', err.message)
      // Non-fatal — continue without graph context
    }
  }
  // ── Combine all context sources ───────────────────────────────────────
  const allContext = [knowledgeContext, graphContext].filter(Boolean).join('\n\n')
  // ── Check if the model is a database-trained custom model ──────────────
  let dbConnectionString = null
  let dbModelName = null
  let dbConnectionMap = null  // Map<label, {connectionString, dbType}> for multi-DB
  try {
    // ── Primary lookup: junction table (supports multi-DB) ───────────────
    const { rows: dbRows } = await query(
      `SELECT cmd.db_label, cmd.db_connection_string, cmd.db_type,
              cm.model_name, cm.ollama_tag
       FROM custom_model_databases cmd
       JOIN custom_models cm ON cm.id = cmd.model_id
       WHERE cm.tenant_id = $1
         AND cm.data_source IN ('database', 'nosql')
         AND cm.status = 'COMPLETED'
         AND cmd.db_connection_string IS NOT NULL
         AND cmd.db_connection_string != ''
         AND (cm.ollama_tag = $2 OR cm.model_name = $2
              OR cm.ollama_tag = split_part($2, ':', 1)
              OR cm.model_name = split_part($2, ':', 1))
       ORDER BY cmd.sort_order`,
      [tenantId, model]
    )

    if (dbRows.length > 1) {
      // ── Multi-DB mode ──────────────────────────────────────────────────
      dbConnectionMap = new Map()
      for (const row of dbRows) {
        dbConnectionMap.set(row.db_label, {
          connectionString: row.db_connection_string,
          dbType: row.db_type,
        })
      }
      dbConnectionString = dbRows[0].db_connection_string
      dbModelName = dbRows[0].model_name || dbRows[0].ollama_tag || 'database'
    } else if (dbRows.length === 1) {
      // ── Single-DB mode (via junction table) ─────────────────────────────
      dbConnectionString = dbRows[0].db_connection_string
      dbModelName = dbRows[0].model_name || dbRows[0].ollama_tag || 'database'
    } else {
      // ── Legacy fallback: pre-migration models with only db_connection_string ──
      const { rows: [customModel] } = await query(
        `SELECT db_connection_string, model_name, ollama_tag FROM custom_models
         WHERE tenant_id = $1
           AND data_source = 'database'
           AND status = 'COMPLETED'
           AND db_connection_string IS NOT NULL
           AND db_connection_string != ''
           AND (ollama_tag = $2 OR model_name = $2
                OR ollama_tag = split_part($2, ':', 1)
                OR model_name = split_part($2, ':', 1))
         LIMIT 1`,
        [tenantId, model]
      )
      if (customModel?.db_connection_string) {
        dbConnectionString = customModel.db_connection_string
        dbModelName = customModel.model_name || customModel.ollama_tag || 'database'
      }
    }
  } catch {
    // If the lookup fails, fall back to normal mode — non-critical
  }

  // ── Normal mode: no database tools, just stream ────────────────────────
  if (!dbConnectionString) {
    const augmentedMessages = allContext
      ? [
          {
            role: 'system',
            content: `You have access to the following relevant information. Use this to answer the user's question accurately. If the information doesn't fully answer the question, supplement with your own knowledge but clearly distinguish between sourced information and your own knowledge.\n\n${allContext}`
          },
          ...messages
        ]
      : messages

    const response = await completeStream({
      tenantId,
      agentId: userId,
      messages: augmentedMessages,
      model,
      llmConfig,
      provider,
      temperature: 0.7,
      onToken,
    })

    await addMessage({
      conversationId,
      role: 'assistant',
      content: response.content,
      model: response.model || model,
      promptTokens: response.usage?.prompt || 0,
      completionTokens: response.usage?.completion || 0,
    })

    return response
  }

  // ── Database-tool mode: tool-calling loop with live query execution ────
  let currentMessages = [...messages]

  // Build list of available DBs for the system prompt
  const dbLabelList = dbConnectionMap
    ? [...dbConnectionMap.keys()].map(l => `"${l}"`).join(', ')
    : ''

  // Prepend a strong system message so the model knows it MUST use tools
  const dbSystemMessage = {
    role: 'system',
    content: (dbConnectionMap
      ? `You are a database assistant connected to multiple databases: ${dbLabelList}.

CRITICAL RULES — you MUST follow these:
1. Start by calling listDatabases to see all available data sources.
2. Before querying any database, call useDatabase to switch to it.
3. Then call listTables, describeTable (to see columns + foreign keys), and finally runQuery — in that order.
4. NEVER answer from memory or training data — always query the LIVE database.
5. When switching between databases, call useDatabase again.
6. SQL PATTERNS: "top X buyers" → JOIN customers + orders, GROUP BY company_name, COUNT(order_id) DESC. "top X products" → JOIN products + order_details, GROUP BY product_name, SUM(quantity) DESC.
7. If a tool returns an error or empty results, report that honestly — NEVER fabricate data.
8. You MUST call a tool on your first response. Do NOT output prose — output a tool call JSON. The only exceptions are: "hello", "hi", "thanks", "goodbye", or "what can you do".`
      : `You are a database assistant connected to the "${dbModelName}" database. 

CRITICAL RULES — you MUST follow these:
1. ALWAYS start by calling listTables to discover what data is available.
2. BEFORE writing ANY SQL query, call describeTable on the relevant table(s). describeTable returns: columns (name+type), foreignKeys (tables this one references), referencedBy (tables that JOIN to this one), and sample rows. Use foreignKeys to write correct JOINs.
3. NEVER answer from memory or training data — always query the LIVE database using runQuery. Only use column names confirmed by describeTable.
4. SQL PATTERNS: "top X buyers" → JOIN customers + orders, GROUP BY company_name, COUNT(order_id) DESC. "top X products" → JOIN products + order_details, GROUP BY product_name, SUM(quantity) DESC. There is NO "SalesAmount" or "Buyer" column — use COUNT/SUM with JOINs.
5. When presenting results, mention that the data comes from the "${dbModelName}" database (e.g. "Based on the ${dbModelName} database...").
6. If a tool returns an error or empty results, report that honestly — NEVER fabricate data to fill a gap.
7. You MUST call a tool on your first response. Do NOT output prose — output a tool call JSON. The only exceptions are: "hello", "hi", "thanks", "goodbye", or "what can you do". For EVERY other query, call listTables first.`)
    + (allContext ? `\n\nYou also have access to the following relevant information that may help answer the user's question:\n\n${allContext}\n\nUse this context to provide additional background when relevant. After querying the database, incorporate relevant knowledge to enrich your answer.` : ''),
  }

  // Place system message at the front — avoid duplicates if one already exists
  const hasSystem = currentMessages.length > 0 && currentMessages[0].role === 'system'
  if (hasSystem) {
    currentMessages[0] = dbSystemMessage
  } else {
    currentMessages.unshift(dbSystemMessage)
  }

  let finalContent = ''
  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  // Track whether the model has actually queried data yet.
  // Keep tool_choice='required' until runQuery has been called at least once —
  // this prevents Ollama models from calling listTables then immediately
  // hallucinating an answer on the next iteration.
  let hasQueriedData = false

  // Build effective tool list: prepend multi-DB tools when needed
  const effectiveTools = dbConnectionMap
    ? [...MULTI_DB_TOOLS, ...DB_TOOLS]
    : DB_TOOLS

  for (let iter = 0; iter < MAX_CHAT_TOOL_ITERATIONS; iter++) {
    // After first iteration, keep forcing tools until we've actual data from a query.
    // Once runQuery has returned results, switch to 'auto' so the model can synthesise.
    const tc = (!hasQueriedData) ? 'required' : 'auto'

    const resp = await complete({
      tenantId,
      agentId: userId,
      messages: currentMessages,
      tools: effectiveTools,
      model,
      llmConfig,
      provider,
      temperature: 0.2,
      goal: 'Answer database question accurately using live queries',
      tool_choice: tc,
    })

    totalPromptTokens += resp.usage?.prompt || 0
    totalCompletionTokens += resp.usage?.completion || 0

    // No tool calls → model might have ignored tool_choice:required (Ollama)
    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      // On first iteration with DB tools, try to extract JSON from text
      if (iter === 0 && resp.content) {
        const syntheticCall = _tryParseChatToolCall(resp.content)
        if (syntheticCall) {
          // Use the synthetic call as if it were a real tool call
          currentMessages.push({
            role: 'assistant',
            content: resp.content,
            tool_calls: [syntheticCall],
          })
          const result = await _executeChatDbTool(
            syntheticCall.function.name,
            JSON.parse(syntheticCall.function.arguments || '{}'),
            { connectionString: dbConnectionString, connectionMap: dbConnectionMap },
          )
          // Handle DB switching from synthetic call
          if (result._switchConnection) {
            dbConnectionString = result._switchConnection
          }
          if (syntheticCall.function.name === 'runQuery' && result.rows && !result.error) {
            hasQueriedData = true
          }
          if (syntheticCall.function.name === 'useDatabase' && result.switched) {
            hasQueriedData = true  // allow synthesis after explicit DB selection
          }
          currentMessages.push({
            role: 'tool',
            tool_call_id: syntheticCall.id,
            content: JSON.stringify(result),
          })
          continue
        }
        // Couldn't parse JSON — inject a forceful retry prompt
        currentMessages.push({ role: 'assistant', content: resp.content })
        const retryTools = dbConnectionMap
          ? '{"name":"listDatabases","arguments":{}}, {"name":"useDatabase","arguments":{"database":"<name>"}}, {"name":"listTables","arguments":{}}, {"name":"describeTable","arguments":{"table":"<name>"}}, or {"name":"runQuery","arguments":{"sql":"<query>"}}'
          : '{"name":"listTables","arguments":{}}, {"name":"describeTable","arguments":{"table":"<name>"}}, or {"name":"runQuery","arguments":{"sql":"<query>"}}'
        currentMessages.push({
          role: 'user',
          content: `You MUST call a tool right now. Output ONLY a JSON tool call — one of: ${retryTools}. Do NOT output any other text.`,
        })
        continue
      }
      // iter >= 1 with no tool calls but hasn't queried data yet —
      // the model ignored tool_choice:'required'. Inject a retry prompt.
      if (!hasQueriedData && resp.content) {
        currentMessages.push({ role: 'assistant', content: resp.content })
        const retryMsg = dbConnectionMap
          ? 'You have NOT queried any database yet! Call listDatabases, then useDatabase, then listTables, then describeTable, then runQuery. NEVER answer from memory — the answer MUST come from runQuery results. Output the tool call JSON now.'
          : 'You have NOT queried the database yet! Call listTables, then describeTable, then runQuery. NEVER answer from memory — the answer MUST come from runQuery results. Output the tool call JSON now.'
        currentMessages.push({ role: 'user', content: retryMsg })
        continue
      }
      // No content or already queried — model is done
      finalContent = resp.content || ''
      break
    }

    // Add the assistant message with tool calls to history
    currentMessages.push({
      role: 'assistant',
      content: resp.content || '',
      tool_calls: resp.toolCalls,
    })

    // Execute each tool call
    for (const tc of resp.toolCalls) {
      let args = {}
      try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* keep empty */ }

      const result = await _executeChatDbTool(
        tc.function.name,
        args,
        { connectionString: dbConnectionString, connectionMap: dbConnectionMap },
      )

      // Handle DB switching from useDatabase tool
      if (result._switchConnection) {
        dbConnectionString = result._switchConnection
        delete result._switchConnection  // don't expose internal signal to model
      }

      // Once runQuery has returned actual rows (not an error), allow synthesis
      if (tc.function.name === 'runQuery' && result.rows && !result.error) {
        hasQueriedData = true
      }
      // Also allow synthesis after successful DB switch (model may need to then query)
      if (tc.function.name === 'useDatabase' && result.switched) {
        hasQueriedData = true
      }

      currentMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      })

      // ── Column-error retry: if runQuery failed with "column does not exist",
      // inject a prompt telling the model to describeTable first ──
      if (tc.function.name === 'runQuery' && result.error && !hasQueriedData) {
        const errMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error)
        if (/column|does not exist|relation.*does not exist|syntax error/i.test(errMsg)) {
          currentMessages.push({
            role: 'user',
            content: `⚠️  Your SQL failed: "${errMsg}". You MUST call describeTable on the relevant table(s) to see the ACTUAL column names, then rewrite your query using ONLY those columns. Output a tool call JSON now — do NOT fabricate an answer.`,
          })
        }
      }
    }
  }

  // If we somehow didn't get content (all iterations consumed by tool calls),
  // prompt the model one final time without tools to synthesise
  if (!finalContent && currentMessages.length > messages.length) {
    currentMessages.push({
      role: 'user',
      content: 'Please synthesise a concise answer from the query results above. If the data does not contain what was asked for, explain why.',
    })
    const finalResp = await complete({
      tenantId,
      agentId: userId,
      messages: currentMessages,
      model,
      llmConfig,
      provider,
      temperature: 0.3,
      goal: 'Synthesise final answer from database results',
    })
    totalPromptTokens += finalResp.usage?.prompt || 0
    totalCompletionTokens += finalResp.usage?.completion || 0
    finalContent = finalResp.content || ''
  }

  // Save assistant message
  await addMessage({
    conversationId,
    role: 'assistant',
    content: finalContent,
    model,
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
  })

  return { content: finalContent, usage: { prompt: totalPromptTokens, completion: totalCompletionTokens, total: totalPromptTokens + totalCompletionTokens } }
}
