// apps/api/src/services/shared-memory.service.js
// Tenant-wide shared memory — accessible to ALL agents in the same organisation.
// Agents can write discoveries here so other agents benefit from them.

import { query } from '../db/pool.js'
import { AppError } from '../utils/errors.js'

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * List all (non-expired) shared memory entries for a tenant.
 */
export async function listSharedMemory(tenantId, { category } = {}) {
  const { rows } = await query(
    `SELECT id, key, value, category, agent_id, source, expires_at, created_at, updated_at
     FROM tenant_shared_memory
     WHERE tenant_id = $1
       AND (expires_at IS NULL OR expires_at > NOW())
       ${category ? 'AND category = $2' : ''}
     ORDER BY updated_at DESC`,
    category ? [tenantId, category] : [tenantId]
  )
  return rows
}

/**
 * Retrieve memory entries relevant to a goal (full-text ranked).
 * Used by the task executor to inject shared context before each task.
 */
export async function retrieveSharedMemory(tenantId, goal, limit = 15) {
  try {
    if (!goal || goal.trim().length < 3) {
      const { rows } = await query(
        `SELECT key, value, category
         FROM tenant_shared_memory
         WHERE tenant_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY updated_at DESC LIMIT $2`,
        [tenantId, limit]
      )
      return rows
    }

    const { rows } = await query(
      `SELECT key, value, category,
              ts_rank(
                to_tsvector('english', key || ' ' || value),
                plainto_tsquery('english', $2)
              ) AS relevance
       FROM tenant_shared_memory
       WHERE tenant_id = $1
         AND (expires_at IS NULL OR expires_at > NOW())
         AND to_tsvector('english', key || ' ' || value)
             @@ plainto_tsquery('english', $2)
       ORDER BY relevance DESC, updated_at DESC
       LIMIT $3`,
      [tenantId, goal.slice(0, 500), limit]
    )

    // Fallback: if no FTS hit, return most recent entries
    if (rows.length === 0) {
      const { rows: recent } = await query(
        `SELECT key, value, category FROM tenant_shared_memory
         WHERE tenant_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY updated_at DESC LIMIT $2`,
        [tenantId, Math.ceil(limit / 2)]
      )
      return recent
    }
    return rows
  } catch { return [] }
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Upsert a shared memory entry (by key within the tenant).
 */
export async function upsertSharedMemory(tenantId, { key, value, category = 'GENERAL', agentId, taskId, source = 'AGENT', expiresAt } = {}) {
  if (!key || !value) throw new AppError('VALIDATION_ERROR', 'key and value are required', 400)
  if (key.length > 500) throw new AppError('VALIDATION_ERROR', 'key must be ≤ 500 characters', 400)

  const { rows: [row] } = await query(
    `INSERT INTO tenant_shared_memory (tenant_id, key, value, category, agent_id, task_id, source, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, key) DO UPDATE
       SET value = EXCLUDED.value,
           category = EXCLUDED.category,
           agent_id = EXCLUDED.agent_id,
           task_id = EXCLUDED.task_id,
           source = EXCLUDED.source,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()
     RETURNING *`,
    [tenantId, key, value, category, agentId || null, taskId || null, source, expiresAt || null]
  )
  return row
}

/**
 * Delete a specific shared memory entry by id.
 */
export async function deleteSharedMemory(tenantId, entryId) {
  const { rowCount } = await query(
    `DELETE FROM tenant_shared_memory WHERE id = $1 AND tenant_id = $2`,
    [entryId, tenantId]
  )
  if (rowCount === 0) throw new AppError('NOT_FOUND', 'Shared memory entry not found', 404)
}

/**
 * Bulk-clear all entries in a category (or all if category omitted).
 */
export async function clearSharedMemory(tenantId, category) {
  const { rowCount } = await query(
    `DELETE FROM tenant_shared_memory WHERE tenant_id = $1 ${category ? 'AND category = $2' : ''}`,
    category ? [tenantId, category] : [tenantId]
  )
  return rowCount
}

// ── Context injection ────────────────────────────────────────────────────────

/**
 * Build the system-message snippet that gets injected into agent task context.
 * Returns null when there's nothing relevant.
 */
export async function buildSharedMemoryContext(tenantId, goal) {
  const entries = await retrieveSharedMemory(tenantId, goal, 10)
  if (!entries.length) return null

  const lines = entries.map(e => `[${e.category}] ${e.key}: ${e.value}`)
  return {
    role: 'system',
    content: `SHARED ORGANISATION MEMORY (facts known across all agents in this org):\n${lines.join('\n')}\n\nUse this shared knowledge where relevant to the current task.`
  }
}
