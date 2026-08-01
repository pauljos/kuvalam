// apps/api/src/services/task-knowledge.js
// Knowledge retrieval functions — extracted from task.service.js.
import { query } from '../db/pool.js'
import { searchKnowledge } from './knowledge.service.js'
import { embed } from './llm.service.js'
import { decryptCredentials } from './crypto.service.js'

export async function retrieveKnowledge(agent, goal) {
  const contextBlocks = []

  try {
    // 1. Vector search via pgvector (built-in, always available)
    const { rows: kbLinks } = await query(
      'SELECT knowledge_base_id FROM agent_knowledge_bases WHERE agent_id = $1',
      [agent.id]
    )
    if (kbLinks.length > 0) {
      const kbIds = kbLinks.map(r => r.knowledge_base_id)
      const chunks = await searchKnowledge({ tenantId: agent.tenant_id, query: goal, knowledgeBaseIds: kbIds, topK: 5 })
      if (chunks.length > 0) {
        contextBlocks.push({
          role: 'system',
          content: `RELEVANT KNOWLEDGE (vector search):\n${chunks.map(c => `[Source: ${c.documentName}]\n${c.content}`).join('\n\n---\n\n')}`
        })
      }
    }
  } catch (err) {
    console.warn('[Knowledge] Vector search failed:', err.message)
  }

  try {
    // 2. Graph search via Neo4j / ArangoDB (optional, per-agent connector)
    const { getAgentGraphConnectors, searchKnowledgeGraph } = await import('./graph-knowledge.service.js')
    const graphConns = await getAgentGraphConnectors(agent.id, agent.tenant_id)
    if (graphConns.length > 0) {
      // ── Dedup (G5): record that the goal was already graph-searched so the
      // runtime searchGraph tool can short-circuit an identical re-query.
      agent._graphQueriesRun = agent._graphQueriesRun || new Set()
      agent._graphQueriesRun.add(String(goal || '').trim().toLowerCase())
    }
    for (const conn of graphConns) {
      try {
        const graphBlocks = await searchKnowledgeGraph(conn, goal)
        contextBlocks.push(...graphBlocks)
      } catch (err) {
        console.warn(`[Knowledge] Graph search failed for connector ${conn.id}:`, err.message)
      }
    }
  } catch (err) {
    console.warn('[Knowledge] Graph integration failed:', err.message)
  }

  try {
    // 3. External vector DB search (Pinecone, Weaviate, Qdrant, etc.)
    const { rows: vectorConns } = await query(
      `SELECT tc.id, tc.name, tc.tool_id, tc.config FROM tool_connections tc
       WHERE tc.tenant_id = $1 AND tc.status = 'ACTIVE'
         AND (
           tc.tool_id IN ('PINECONE', 'WEAVIATE', 'QDRANT', 'MILVUS', 'VECTORDB', 'VECTOR_DB', 'VECTOR')
           OR (tc.name ILIKE '%vector%') OR (tc.name ILIKE '%pinecone%')
           OR (tc.name ILIKE '%weaviate%') OR (tc.name ILIKE '%qdrant%'))
       LIMIT 3`,
      [agent.tenant_id]
    )
    for (const conn of vectorConns) {
      try {
        const extBlocks = await searchExternalVectorDb(conn, goal, agent.tenant_id)
        contextBlocks.push(...extBlocks)
      } catch (err) {
        console.warn(`[Knowledge] External vector search failed: ${err.message}`)
      }
    }
  } catch (err) {
    console.warn('[Knowledge] External vector DB search failed:', err.message)
  }

  return contextBlocks
}

/**
 * Search an external vector DB (Pinecone, Weaviate, Qdrant, etc.) via HTTP API.
 * Uses the connector's baseUrl + API key to embed the query and search.
 * Best-effort: if the provider API format doesn't match what we try, we fall
 * back gracefully rather than blocking the task.
 */
export async function searchExternalVectorDb(conn, goal, tenantId) {
  const cfg = decryptCredentials(conn.config || {})
  const baseUrl = cfg.baseUrl
  const apiKey = cfg.apiKey || cfg.password || ''

  if (!baseUrl) return []

  try {
    // Embed the query
    const { rows: [tenant] } = await query('SELECT llm_config FROM tenants WHERE id = $1', [tenantId])
    const llmConfig = tenant?.llm_config || {}
    const embeddings = await embed({ text: goal, tenantId, llmConfig })
    const queryVector = embeddings[0]

    // Try common REST patterns for vector DBs
    const headers = {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}`, 'X-API-Key': apiKey } : {}),
    }

    // Pattern 1: POST /search (Qdrant, Weaviate, generic)
    let resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/search`, {
      method: 'POST', headers,
      body: JSON.stringify({ vector: queryVector, limit: 5 }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null)

    // Pattern 2: POST /query (Pinecone REST, Milvus)
    if (!resp || !resp.ok) {
      resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({ vector: queryVector, topK: 5, includeMetadata: true }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => null)
    }

    // Pattern 3: POST /points/search (Qdrant alternative)
    if (!resp || !resp.ok) {
      resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/points/search`, {
        method: 'POST', headers,
        body: JSON.stringify({ vector: queryVector, limit: 5 }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => null)
    }

    if (!resp || !resp.ok) return []

    const data = await resp.json()
    // Extract results in common formats: { results, matches, hits, documents }
    const results = data.results || data.matches || data.hits || data.documents || []
    if (!results.length) return []

    const chunks = results.slice(0, 5).map((r, i) => {
      const text = r.text || r.content || r.payload?.text || r.metadata?.text || JSON.stringify(r).slice(0, 500)
      return `[External Vector DB, match ${i + 1}]: ${text}`
    })

    return [{
      role: 'system',
      content: `RELEVANT KNOWLEDGE (external vector DB):\n${chunks.join('\n\n---\n\n')}`
    }]
  } catch (err) {
    console.warn(`[Knowledge] External vector DB search failed: ${err.message}`)
    return []
  }
}

export async function loadEpisodicMemory(agentId, goal) {
  try {
    const { rows } = await query(
      `SELECT goal_summary, outcome, result_summary FROM agent_episodic_memory
       WHERE agent_id = $1 AND outcome = 'SUCCESS'
       ORDER BY created_at DESC LIMIT 3`,
      [agentId]
    )
    if (rows.length === 0) return []

    return [{
      role: 'system',
      content: `PAST EXPERIENCE (similar tasks):\n${rows.map(r => `- Goal: ${r.goal_summary}\n  Result: ${r.result_summary}`).join('\n')}`
    }]
  } catch {
    return []
  }
}

export async function saveEpisodicMemory(agent, task, result, actions) {
  try {
    await query(
      `INSERT INTO agent_episodic_memory (agent_id, tenant_id, task_id, task_type, goal_summary, outcome, key_actions, result_summary)
       VALUES ($1,$2,$3,$4,$5,'SUCCESS',$6,$7)`,
      [agent.id, agent.tenant_id, task.id, task.priority, task.goal.substring(0, 200), JSON.stringify(actions.map(a => a.skill)), result.summary]
    )
  } catch {
    // Non-critical error - episodic memory is best-effort
  }
}

/**
 * List all episodic (past-experience) memory entries for an agent.
 */
export async function listEpisodicMemory(agentId, tenantId) {
  const { rows } = await query(
    `SELECT id, task_id, task_type, goal_summary, outcome, key_actions, result_summary, lessons, created_at
     FROM agent_episodic_memory
     WHERE agent_id = $1 AND tenant_id = $2
     ORDER BY created_at DESC`,
    [agentId, tenantId]
  )
  return rows
}

/**
 * Delete a single episodic memory entry.
 */
export async function deleteEpisodicMemoryEntry(agentId, tenantId, memoryId) {
  await query(
    `DELETE FROM agent_episodic_memory WHERE id = $1 AND agent_id = $2 AND tenant_id = $3`,
    [memoryId, agentId, tenantId]
  )
}

/**
 * Delete ALL episodic memory entries for an agent.
 */
export async function clearEpisodicMemory(agentId, tenantId) {
  await query(
    `DELETE FROM agent_episodic_memory WHERE agent_id = $1 AND tenant_id = $2`,
    [agentId, tenantId]
  )
}
