// apps/api/src/services/tenant-memory.service.js
// ═══════════════════════════════════════════════════════════════════════════
// Tenant-shared memory (G3).
// ═══════════════════════════════════════════════════════════════════════════
// A cross-agent entity store scoped to a tenant. Any agent may READ.
// Only agents with the built-in 'write_tenant_memory' scope (or the tenant
// supervisor) may WRITE.
//
// Table: tenant_memory  (see migration 031)
//
// This is the "hive mind" layer: customer names, project constants, product
// SKUs, decisions — anything one agent learns and every other agent should
// be able to recall without re-derivation.
// ═══════════════════════════════════════════════════════════════════════════

import { query } from '../db/pool.js'

/**
 * Upsert an entity into tenant-shared memory.
 * Silently no-ops on error to avoid blocking the calling agent.
 */
export async function writeTenantMemory(tenantId, {
  entityType, entityName, detail,
  sourceAgent = null, sourceTask = null, visibility = 'TENANT',
}) {
  if (!tenantId || !entityType || !entityName) return null
  try {
    const { rows: [row] } = await query(
      `INSERT INTO tenant_memory
         (tenant_id, entity_type, entity_name, detail, source_agent, source_task, visibility, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (tenant_id, entity_type, entity_name)
       DO UPDATE SET
         detail       = EXCLUDED.detail,
         source_agent = EXCLUDED.source_agent,
         source_task  = EXCLUDED.source_task,
         last_seen_at = NOW()
       RETURNING *`,
      [tenantId, entityType, entityName, detail || null, sourceAgent, sourceTask, visibility]
    )
    return row
  } catch (err) {
    console.warn(`[TenantMemory] Write failed: ${err.message}`)
    return null
  }
}

/**
 * Search tenant-shared memory by keyword relevance to a goal.
 * Returns up to `limit` entries scored by tsvector rank.
 */
export async function searchTenantMemory(tenantId, goal, limit = 15) {
  if (!tenantId) return []
  try {
    if (goal && goal.trim().length > 3) {
      const { rows } = await query(
        `SELECT entity_type, entity_name, detail, last_seen_at,
                ts_rank(
                  to_tsvector('english', entity_name || ' ' || COALESCE(detail, '')),
                  plainto_tsquery('english', $2)
                ) AS relevance
         FROM tenant_memory
         WHERE tenant_id = $1
           AND visibility = 'TENANT'
           AND to_tsvector('english', entity_name || ' ' || COALESCE(detail, ''))
               @@ plainto_tsquery('english', $2)
         ORDER BY relevance DESC, last_seen_at DESC
         LIMIT $3`,
        [tenantId, goal.slice(0, 500), limit]
      )
      if (rows.length > 0) return rows
    }
    // No keyword match and no goal — return nothing.
    // Do NOT fall back to most-recent entries: injecting unrelated shared facts
    // (from a different agent's domain) contaminates context without relevance.
    return []
  } catch (err) {
    console.warn(`[TenantMemory] Search failed: ${err.message}`)
    return []
  }
}

/**
 * Format tenant-memory rows as a compact system prompt block.
 * Returns '' if nothing to inject.
 */
export function formatTenantMemoryForPrompt(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  const lines = entries.map(e => {
    const detail = e.detail ? ` — ${String(e.detail).slice(0, 200)}` : ''
    return `- [${e.entity_type}] ${e.entity_name}${detail}`
  })
  return `\n## SHARED TENANT MEMORY (facts known by other agents)\n${lines.join('\n')}\n`
}

/**
 * List everything for admin UI. Tenant-scoped, paginated.
 */
export async function listTenantMemory(tenantId, { limit = 100, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT id, entity_type, entity_name, detail, source_agent, source_task,
            visibility, last_seen_at, created_at
     FROM tenant_memory
     WHERE tenant_id = $1
     ORDER BY last_seen_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  )
  return rows
}

export async function deleteTenantMemoryEntry(tenantId, id) {
  const { rowCount } = await query(
    `DELETE FROM tenant_memory WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  )
  return rowCount > 0
}

export async function clearTenantMemory(tenantId) {
  const { rowCount } = await query(
    `DELETE FROM tenant_memory WHERE tenant_id = $1`,
    [tenantId]
  )
  return rowCount
}
