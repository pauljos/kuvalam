// apps/api/src/utils/audit.js
import { query } from '../db/pool.js'

export async function auditLog({
  tenantId = null,
  eventType,
  actorType = 'SYSTEM',
  actorId = 'system',
  resourceType = null,
  resourceId = null,
  action,
  beforeState = null,
  afterState = null,
  metadata = {},
  ip = null,
  traceId = null
}) {
  try {
    await query(
      `INSERT INTO audit_log (tenant_id, event_type, actor_type, actor_id, resource_type, resource_id, action, before_state, after_state, metadata, ip_address, trace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [tenantId, eventType, actorType, actorId, resourceType, resourceId, action,
       beforeState ? JSON.stringify(beforeState) : null,
       afterState ? JSON.stringify(afterState) : null,
       JSON.stringify(metadata), ip, traceId]
    )
  } catch (err) {
    // Audit failure must never break the main flow
    console.error('Audit log write failed:', err.message)
  }
}
