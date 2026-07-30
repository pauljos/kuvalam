// apps/api/src/services/graph-knowledge.service.js
// Knowledge Graph integration — connects to Neo4j or ArangoDB for
// entity-relationship traversal during agent task execution.
//
// Users create a knowledge-graph connector in Settings → Connectors,
// then scope it to an agent. When the agent runs, retrieveKnowledge()
// queries the graph for relevant entities and relationships.
//
// The graph is populated via the same document ingestion pipeline:
// documents are chunked → entities extracted via LLM → upserted into
// the graph with relationships.

import { query } from '../db/pool.js'
import { decryptCredentials } from './crypto.service.js'

// ─── Connection ─────────────────────────────────────────────────────────

/**
 * Build a connection config from a tool_connections row.
 * Decrypts credentials and returns { kind, url, username, password, database }.
 */
function buildConnectionConfig(conn) {
  const cfg = decryptCredentials(conn.config || {})
  const kind = cfg.kind || 'neo4j'
  const baseUrl = cfg.baseUrl || 'bolt://localhost:7687'
  const username = cfg.username || 'neo4j'
  const password = cfg.password || ''
  const database = cfg.database || 'neo4j'

  return { kind, baseUrl, username, password, database }
}

/**
 * Test if a knowledge-graph connector is reachable.
 * Returns { success: bool, message: string }.
 */
export async function verifyGraphConnector(conn) {
  try {
    const { kind, baseUrl, username, password, database } = buildConnectionConfig(conn)
    
    if (kind === 'neo4j') {
      // Ping Neo4j via HTTP API
      const httpUrl = baseUrl.replace('bolt://', 'http://').replace(':7687', ':7474')
      const auth = Buffer.from(`${username}:${password}`).toString('base64')
      const resp = await fetch(`${httpUrl}/db/${database}/tx/commit`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ statements: [{ statement: 'RETURN 1 AS ok' }] }),
        signal: AbortSignal.timeout(5000),
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        return { success: false, message: `Neo4j returned ${resp.status}: ${body.slice(0, 200)}` }
      }
      return { success: true, message: 'Neo4j reachable — graph queries available' }
    }
    
    if (kind === 'arangodb') {
      const resp = await fetch(`${baseUrl}/_api/version`, {
        headers: { 'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
        signal: AbortSignal.timeout(5000),
      })
      if (!resp.ok) {
        return { success: false, message: `ArangoDB returned ${resp.status}` }
      }
      return { success: true, message: 'ArangoDB reachable — graph queries available' }
    }
    
    return { success: false, message: `Unknown graph kind: ${kind}` }
  } catch (err) {
    return { success: false, message: `Graph connection failed: ${err.message}` }
  }
}

// ─── Neo4j Cypher Execution ─────────────────────────────────────────────

async function executeNeo4jQuery(conn, cypher, params = {}) {
  const { baseUrl, username, password, database } = buildConnectionConfig(conn)
  const httpUrl = baseUrl.replace('bolt://', 'http://').replace(':7687', ':7474')
  const auth = Buffer.from(`${username}:${password}`).toString('base64')

  const resp = await fetch(`${httpUrl}/db/${database}/tx/commit`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ statements: [{ statement: cypher, parameters: params }] }),
    signal: AbortSignal.timeout(10000),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Neo4j query failed (${resp.status}): ${body.slice(0, 300)}`)
  }

  const json = await resp.json()
  if (json.errors?.length) {
    throw new Error(`Neo4j error: ${json.errors[0].message || json.errors[0].code}`)
  }

  // Transform Neo4j response to simple { columns, rows } format
  const result = json.results?.[0]
  if (!result) return { columns: [], rows: [] }

  const columns = result.columns || []
  const rows = (result.data || []).map(d => {
    const row = {}
    for (const col of columns) {
      const val = d.row?.[columns.indexOf(col)]
      // Unwrap Neo4j node/relationship objects
      if (val && typeof val === 'object' && val.properties) {
        row[col] = { ...val.properties, _labels: val.labels || val.type }
      } else {
        row[col] = val
      }
    }
    return row
  })

  return { columns, rows }
}

// ─── ArangoDB AQL Execution ─────────────────────────────────────────────

async function executeArangoQuery(conn, aql, bindVars = {}) {
  const { baseUrl, username, password, database } = buildConnectionConfig(conn)

  const resp = await fetch(`${baseUrl}/_db/${database}/_api/cursor`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: aql, bindVars, batchSize: 50 }),
    signal: AbortSignal.timeout(10000),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`ArangoDB query failed (${resp.status}): ${body.slice(0, 300)}`)
  }

  const json = await resp.json()
  return { columns: json.result?.length ? Object.keys(json.result[0]) : [], rows: json.result || [] }
}

// ─── Entity Extraction & Ingestion ──────────────────────────────────────

/**
 * Extract entities and relationships from text using an LLM.
 * Returns { entities: [{ name, type, properties }], relationships: [{ from, to, type, properties }] }.
 */
async function extractEntitiesFromText(text, llmConfig, provider) {
  // Use a simple LLM call to extract entities as JSON
  const { complete } = await import('./llm.service.js')
  
  const prompt = `Extract named entities and their relationships from the following text. 
Output ONLY valid JSON in this exact format:
{
  "entities": [
    { "name": "EntityName", "type": "PERSON|ORG|LOCATION|PRODUCT|CONCEPT|EVENT|DATE|MONEY|OTHER", "properties": { "key": "value" } }
  ],
  "relationships": [
    { "from": "EntityName", "to": "EntityName", "type": "WORKS_FOR|LOCATED_IN|OWNS|PRODUCES|RELATED_TO|PART_OF|DEPENDS_ON|USES", "properties": {} }
  ]
}

Text:
${text.slice(0, 3000)}`

  try {
    const response = await complete({
      messages: [{ role: 'user', content: prompt }],
      model: llmConfig?.model || 'gpt-4o-mini',
      llmConfig,
      provider: provider || 'openai',
      temperature: 0.1,
    })
    
    const content = response.content || ''
    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
    return { entities: [], relationships: [] }
  } catch (err) {
    console.warn('[Graph] Entity extraction failed:', err.message)
    return { entities: [], relationships: [] }
  }
}

/**
 * Ingest a document's entities into the knowledge graph.
 * Called after document chunking/embedding in knowledge.service.js.
 */
export async function ingestEntitiesToGraph(conn, documentId, text, llmConfig, provider) {
  const { kind } = buildConnectionConfig(conn)
  const extracted = await extractEntitiesFromText(text, llmConfig, provider)
  
  if (extracted.entities.length === 0) return { entities: 0, relationships: 0 }
  
  try {
    if (kind === 'neo4j') {
      // Create nodes
      for (const entity of extracted.entities) {
        const safeType = entity.type.replace(/[^a-zA-Z0-9_]/g, '_')
        await executeNeo4jQuery(conn,
          `MERGE (n:${safeType} {name: $name})
           SET n += $props, n.document_id = $docId, n.updated_at = datetime()`,
          { name: entity.name, props: entity.properties || {}, docId: documentId }
        )
      }
      // Create relationships
      for (const rel of extracted.relationships) {
        const safeType = rel.type.replace(/[^a-zA-Z0-9_]/g, '_')
        await executeNeo4jQuery(conn,
          `MATCH (a {name: $from}), (b {name: $to})
           MERGE (a)-[r:${safeType}]->(b)
           SET r += $props, r.document_id = $docId, r.updated_at = datetime()`,
          { from: rel.from, to: rel.to, props: rel.properties || {}, docId: documentId }
        )
      }
    } else if (kind === 'arangodb') {
      // Create vertices
      for (const entity of extracted.entities) {
        const safeType = entity.type.replace(/[^a-zA-Z0-9_]/g, '_')
        await executeArangoQuery(conn,
          `UPSERT { name: @name, _type: @type }
           INSERT { name: @name, _type: @type, document_id: @docId, updated_at: DATE_NOW(), @props }
           UPDATE { document_id: @docId, updated_at: DATE_NOW(), @props }
           IN @@collection`,
          {
            name: entity.name,
            type: safeType,
            docId: documentId,
            props: entity.properties || {},
            '@collection': safeType,
          }
        )
      }
      // Create edges
      for (const rel of extracted.relationships) {
        const safeType = rel.type.replace(/[^a-zA-Z0-9_]/g, '_')
        await executeArangoQuery(conn,
          `LET from = FIRST(FOR v IN @@any FILTER v.name == @from RETURN v._id)
           LET to = FIRST(FOR v IN @@any FILTER v.name == @to RETURN v._id)
           FILTER from != null AND to != null
           INSERT { _from: from, _to: to, _type: @relType, document_id: @docId, updated_at: DATE_NOW() }
           INTO @@edgeCollection`,
          {
            from: rel.from,
            to: rel.to,
            relType: safeType,
            docId: documentId,
            '@any': 'ANY',
            '@edgeCollection': safeType,
          }
        )
      }
    }
    
    return { entities: extracted.entities.length, relationships: extracted.relationships.length }
  } catch (err) {
    console.warn('[Graph] Entity ingestion failed:', err.message)
    return { entities: 0, relationships: 0 }
  }
}

// ─── Graph Search for Agent Execution ───────────────────────────────────

/**
 * Search the knowledge graph for entities and relationships relevant to a task goal.
 * Returns formatted context block for system prompt injection.
 */
export async function searchKnowledgeGraph(conn, goal, { maxEntities = 10 } = {}) {
  const { kind } = buildConnectionConfig(conn)
  
  try {
    if (kind === 'neo4j') {
      return searchNeo4j(conn, goal, maxEntities)
    } else if (kind === 'arangodb') {
      return searchArangoDB(conn, goal, maxEntities)
    }
    return []
  } catch (err) {
    console.warn('[Graph] Search failed:', err.message)
    return []
  }
}

async function searchNeo4j(conn, goal, maxEntities) {
  // Extract potential entity names from the goal using simple keyword matching.
  // A full embedding-based search would be ideal but requires an embedding model
  // for graph entities. For now, use fuzzy text matching via CONTAINS.
  const words = goal.split(/\s+/).filter(w => w.length > 3).slice(0, 5)

  // ── Tenant isolation: filter by _source_graph when present, fall back
  // to tenant_id. This ensures one tenant's graph entities never leak into
  // another tenant's agent context. ──
  const tenantId = conn.tenant_id || ''
  const sourceGraph = conn.config?._source_graph || `${tenantId}-${conn.name || 'graph'}`
  const isolationClause = tenantId
    ? `AND (n.tenant_id = $tenantId OR n._source_graph = $sourceGraph)`
    : ''

  // Find entities whose name contains any goal keyword
  const cypherParams = Object.fromEntries(
    words.map((w, i) => [`word${i}`, w])
      .concat([['limit', maxEntities]])
      .concat(tenantId ? [['tenantId', tenantId], ['sourceGraph', sourceGraph]] : [])
  )
  const results = await executeNeo4jQuery(conn,
    `MATCH (n)
     WHERE n.name IS NOT NULL
       ${isolationClause}
       AND (${words.map((_, i) => `toLower(n.name) CONTAINS toLower($word${i})`).join(' OR ')})
     OPTIONAL MATCH (n)-[r]->(m)
     WHERE m.name IS NOT NULL
     RETURN n.name AS entity, labels(n) AS entity_type, n AS entity_props,
            collect(DISTINCT { type: type(r), target: m.name, target_type: labels(m) }) AS relationships
     LIMIT $limit`,
    cypherParams
  )
  
  if (results.rows.length === 0) return []
  
  return [{
    role: 'system',
    content: `KNOWLEDGE GRAPH (entities & relationships):\n${results.rows.map(r => {
      const rels = (r.relationships || []).filter(rl => rl.type).map(rl => `  → ${rl.type} → ${rl.target} (${(rl.target_type || []).join(', ')})`).join('\n')
      return `• ${r.entity} [${(r.entity_type || []).join(', ')}]${rels ? '\n' + rels : ''}`
    }).join('\n\n')}`
  }]
}

async function searchArangoDB(conn, goal, maxEntities) {
  const words = goal.split(/\s+/).filter(w => w.length > 3).slice(0, 5)
  
  const results = await executeArangoQuery(conn,
    `FOR v IN ANY
     FILTER v.name != null
       AND (${words.map((_, i) => `CONTAINS(LOWER(v.name), LOWER(@word${i}))`).join(' OR ')})
     LET edges = (
       FOR v2, e IN 1..1 OUTBOUND v GRAPH 'kuvalam_graph'
       RETURN { type: e._type, target: v2.name, target_type: v2._type }
     )
     LIMIT @limit
     RETURN { entity: v.name, entity_type: v._type, entity_props: v, relationships: edges }`,
    Object.fromEntries(words.map((w, i) => [`word${i}`, w]).concat([['limit', maxEntities]]))
  )
  
  if (results.rows.length === 0) return []
  
  return [{
    role: 'system',
    content: `KNOWLEDGE GRAPH (entities & relationships):\n${results.rows.map(r => {
      const rels = (r.relationships || []).filter(rl => rl && rl.type).map(rl => `  → ${rl.type} → ${rl.target} (${rl.target_type || '?'})`).join('\n')
      return `• ${r.entity} [${r.entity_type || '?'}]${rels ? '\n' + rels : ''}`
    }).join('\n\n')}`
  }]
}

/**
 * Get all knowledge-graph connectors scoped to an agent.
 * Returns an array of tool_connections rows (decrypted).
 */
export async function getAgentGraphConnectors(agentId, tenantId) {
  try {
    const { rows } = await query(
      `SELECT tc.* FROM tool_connections tc
       JOIN agent_tool_scopes ats ON ats.connector_id = tc.id
       WHERE ats.agent_id = $1 AND tc.tenant_id = $2
         AND tc.tool_id IN ('knowledge-graph')
         AND tc.status = 'ACTIVE'
         AND ats.scope_type = 'connector'
       ORDER BY tc.created_at ASC`,
      [agentId, tenantId]
    )
    return rows
  } catch {
    return []
  }
}

/**
 * Get all vector-db connectors scoped to an agent.
 */
export async function getAgentVectorDbConnectors(agentId, tenantId) {
  try {
    const { rows } = await query(
      `SELECT tc.* FROM tool_connections tc
       JOIN agent_tool_scopes ats ON ats.connector_id = tc.id
       WHERE ats.agent_id = $1 AND tc.tenant_id = $2
         AND tc.tool_id IN ('vector-db')
         AND tc.status = 'ACTIVE'
         AND ats.scope_type = 'connector'
       ORDER BY tc.created_at ASC`,
      [agentId, tenantId]
    )
    return rows
  } catch {
    return []
  }
}
