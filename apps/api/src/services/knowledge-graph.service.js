// apps/api/src/services/knowledge-graph.service.js
// Named Knowledge Graphs — a first-class concept (like Knowledge Bases) backed
// by Neo4j or ArangoDB. Agents link directly to graphs, not through tool_connections.
//
// This is separate from graph-knowledge.service.js which handles the runtime
// Cypher/AQL query execution during agent tasks.

import { query } from '../db/pool.js'
import { auditLog } from '../utils/audit.js'
import { AppError } from '../utils/errors.js'
import { checkPlanLimit } from './plan-limits.service.js'
import { resolveNeo4jConfig } from './graph-db-importer.service.js'

export async function createKnowledgeGraph({ tenantId, name, description, graphKind, host, httpPort, boltPort, username, databaseName, userId }) {
  const { rows: [countRow] } = await query(
    'SELECT COUNT(*) as count FROM knowledge_graphs WHERE tenant_id = $1',
    [tenantId]
  )
  await checkPlanLimit(tenantId, 'knowledge_graphs', parseInt(countRow?.count || 0))

  const { rows: [graph] } = await query(
    `INSERT INTO knowledge_graphs (tenant_id, name, description, graph_kind, host, http_port, bolt_port, username, database_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [tenantId, name, description || '', graphKind || 'neo4j', host || process.env.NEO4J_HOST || '', httpPort || process.env.NEO4J_HTTP_PORT || '7474', boltPort || process.env.NEO4J_BOLT_PORT || '7687', username || process.env.NEO4J_USER || 'neo4j', databaseName || process.env.NEO4J_DATABASE || 'neo4j']
  )
  await auditLog({
    eventType: 'knowledge.graph_created', tenantId, actorId: userId, actorType: 'USER',
    resourceType: 'KnowledgeGraph', resourceId: graph.id, action: 'CREATE'
  })
  return graph
}

export async function listKnowledgeGraphs(tenantId) {
  const { rows } = await query(
    'SELECT * FROM knowledge_graphs WHERE tenant_id = $1 ORDER BY created_at DESC',
    [tenantId]
  )
  return rows
}

export async function getKnowledgeGraph(tenantId, graphId) {
  const { rows: [graph] } = await query(
    'SELECT * FROM knowledge_graphs WHERE id = $1 AND tenant_id = $2',
    [graphId, tenantId]
  )
  if (!graph) throw new AppError('GRAPH_NOT_FOUND', 'Knowledge graph not found', 404)
  return graph
}

export async function deleteKnowledgeGraph(tenantId, graphId, userId) {
  const { rows: [graph] } = await query(
    'SELECT * FROM knowledge_graphs WHERE id = $1 AND tenant_id = $2',
    [graphId, tenantId]
  )
  if (!graph) throw new AppError('GRAPH_NOT_FOUND', 'Knowledge graph not found', 404)

  await query('DELETE FROM knowledge_graphs WHERE id = $1 AND tenant_id = $2', [graphId, tenantId])
  await auditLog({
    eventType: 'knowledge.graph_deleted', tenantId, actorId: userId, actorType: 'USER',
    resourceType: 'KnowledgeGraph', resourceId: graphId, action: 'DELETE'
  })
  return { deleted: true }
}

// ─── Agent linking ───────────────────────────────────────────────────────

export async function linkKnowledgeGraph(tenantId, agentId, graphId, userId) {
  await query(
    'INSERT INTO agent_knowledge_graphs (agent_id, knowledge_graph_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [agentId, graphId]
  )
  await auditLog({
    eventType: 'agent.knowledge_graph_linked', tenantId, actorId: userId, actorType: 'USER',
    resourceType: 'Agent', resourceId: agentId, action: 'LINK_GRAPH'
  })
  return { linked: true }
}

export async function unlinkKnowledgeGraph(tenantId, agentId, graphId, userId) {
  await query(
    'DELETE FROM agent_knowledge_graphs WHERE agent_id = $1 AND knowledge_graph_id = $2',
    [agentId, graphId]
  )
  await auditLog({
    eventType: 'agent.knowledge_graph_unlinked', tenantId, actorId: userId, actorType: 'USER',
    resourceType: 'Agent', resourceId: agentId, action: 'UNLINK_GRAPH'
  })
  return { unlinked: true }
}

// ─── Entity Management (Neo4j-backed) ────────────────────────────────────

async function neo4jQuery({ host, httpPort, username, password, database }, cypher, params = {}) {
  const httpUrl = `http://${host}:${httpPort || 7474}`
  const auth = Buffer.from(`${username}:${password}`).toString('base64')

  const resp = await fetch(`${httpUrl}/db/${database}/tx/commit`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
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

export async function addGraphEntity({ tenantId, graphId, label, type, userId }) {
  const neo4j = await resolveNeo4jConfig(tenantId, graphId)

  const safeLabel = label.replace(/[^a-zA-Z0-9_]/g, '_')
  await neo4jQuery(neo4j, `
    MERGE (n:Entity {_entity_label: $label, _source_graph: $graphId})
    SET n.name = $label,
        n.type = $type,
        n.created_at = coalesce(n.created_at, datetime()),
        n.updated_at = datetime()
    RETURN n
  `, { label, type: type || 'Entity', graphId })

  // Update counts
  const countRes = await neo4jQuery(neo4j, `
    MATCH (n:Entity {_source_graph: $graphId}) RETURN count(n) AS cnt
  `, { graphId })
  const entityCount = countRes?.data?.[0]?.row?.[0] || 0

  await query(
    `UPDATE knowledge_graphs SET entity_count = $1, updated_at = NOW() WHERE id = $2`,
    [parseInt(entityCount), graphId]
  )

  await auditLog({
    eventType: 'knowledge.graph_entity_added', tenantId, actorId: userId, actorType: 'USER',
    resourceType: 'KnowledgeGraph', resourceId: graphId, action: 'ADD_ENTITY'
  })

  return { id: label, label, type, entity_count: parseInt(entityCount) }
}

export async function listGraphEntities(tenantId, graphId) {
  const neo4j = await resolveNeo4jConfig(tenantId, graphId)

  const result = await neo4jQuery(neo4j, `
    MATCH (n:Entity {_source_graph: $graphId})
    RETURN n.name AS label, n.type AS type, n.created_at AS created_at
    ORDER BY n.created_at DESC
  `, { graphId })

  const entities = (result?.data || []).map(row => ({
    label: row.row?.[0],
    type: row.row?.[1],
    created_at: row.row?.[2],
  }))

  return entities
}

export async function deleteGraphEntity(tenantId, graphId, entityLabel, userId) {
  const neo4j = await resolveNeo4jConfig(tenantId, graphId)

  await neo4jQuery(neo4j, `
    MATCH (n:Entity {_entity_label: $entityLabel, _source_graph: $graphId})
    DETACH DELETE n
  `, { entityLabel, graphId })

  // Update counts
  const countRes = await neo4jQuery(neo4j, `
    MATCH (n:Entity {_source_graph: $graphId}) RETURN count(n) AS cnt
  `, { graphId })
  const entityCount = countRes?.data?.[0]?.row?.[0] || 0

  await query(
    `UPDATE knowledge_graphs SET entity_count = $1, updated_at = NOW() WHERE id = $2`,
    [parseInt(entityCount), graphId]
  )

  await auditLog({
    eventType: 'knowledge.graph_entity_deleted', tenantId, actorId: userId, actorType: 'USER',
    resourceType: 'KnowledgeGraph', resourceId: graphId, action: 'DELETE_ENTITY'
  })

  return { deleted: true, label: entityLabel, entity_count: parseInt(entityCount) }
}
