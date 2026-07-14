// apps/api/src/services/memory.service.js
// Long-term semantic memory for agents
// After each completed task, extracts named entities and facts and stores them
// so future tasks can recall them without re-processing source documents.

import { query } from '../db/pool.js'
import { complete } from './llm.service.js'

// ─── Entity extraction ────────────────────────────────────────────────────────
const EXTRACT_SYSTEM = `You are an entity extraction engine. Extract named entities and facts from the text.
Return ONLY valid JSON in this exact shape:
{
  "entities": [
    { "type": "PERSON|ORG|PRODUCT|DATE|LOCATION|CONCEPT|FACT", "name": "...", "detail": "brief context" }
  ]
}
Return an empty entities array if nothing worth storing.`

export async function extractAndStoreMemory(agentId, tenantId, taskId, content, llmConfig = {}, provider) {
  if (!content || content.length < 50) return

  try {
    const res = await complete({
      tenantId,
      agentId,
      llmConfig,
      provider,
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: content.slice(0, 6000) } // cap input tokens
      ],
      model: 'gpt-4o-mini' // always use fast model for extraction
    })

    let parsed
    try {
      const jsonMatch = res.content.match(/\{[\s\S]*\}/)
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null
    } catch { return }

    if (!parsed?.entities?.length) return

    // Upsert entities — update detail if same agent has seen this entity before
    for (const entity of parsed.entities) {
      if (!entity.name || !entity.type) continue
      await query(
        `INSERT INTO agent_memory (agent_id, tenant_id, task_id, entity_type, entity_name, detail, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (agent_id, entity_type, entity_name)
         DO UPDATE SET detail = EXCLUDED.detail, last_seen_at = NOW(), task_id = EXCLUDED.task_id`,
        [agentId, tenantId, taskId, entity.type, entity.name, entity.detail]
      ).catch(() => {}) // non-critical
    }
  } catch { /* non-critical */ }
}

/**
 * Retrieve relevant memory entries for a given goal using keyword matching.
 * Returns formatted message context to inject into the agent's prompt.
 */
export async function retrieveMemory(agentId, goal, limit = 20) {
  try {
    const { rows } = await query(
      `SELECT entity_type, entity_name, detail, last_seen_at
       FROM agent_memory
       WHERE agent_id = $1
       ORDER BY last_seen_at DESC
       LIMIT $2`,
      [agentId, limit]
    )
    if (rows.length === 0) return []

    const formatted = rows
      .map(r => `[${r.entity_type}] ${r.entity_name}: ${r.detail}`)
      .join('\n')

    return [{
      role: 'system',
      content: `LONG-TERM MEMORY (facts and entities I've learned from past tasks):\n${formatted}\n\nUse this knowledge where relevant.`
    }]
  } catch { return [] }
}

/**
 * Get all memory entries for an agent — used in the UI memory viewer.
 */
export async function listMemory(agentId, tenantId) {
  const { rows } = await query(
    `SELECT * FROM agent_memory WHERE agent_id = $1 AND tenant_id = $2 ORDER BY last_seen_at DESC`,
    [agentId, tenantId]
  )
  return rows
}

export async function deleteMemoryEntry(agentId, tenantId, memoryId) {
  await query(
    `DELETE FROM agent_memory WHERE id = $1 AND agent_id = $2 AND tenant_id = $3`,
    [memoryId, agentId, tenantId]
  )
}
