// apps/api/src/routes/audit.routes.js
import { query } from '../db/pool.js'

export default async function auditRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate)

  // List audit log entries
  fastify.get('/tenants/:tenantId/audit', async (req, reply) => {
    const { tenantId } = req.params
    const { eventType, actorType, resourceType, limit = 100, offset = 0 } = req.query

    let sql = `SELECT * FROM audit_log WHERE tenant_id = $1`
    const params = [tenantId]

    if (eventType) {
      params.push(eventType)
      sql += ` AND event_type = $${params.length}`
    }
    if (actorType) {
      params.push(actorType)
      sql += ` AND actor_type = $${params.length}`
    }
    if (resourceType) {
      params.push(resourceType)
      sql += ` AND resource_type = $${params.length}`
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(Math.min(parseInt(limit) || 100, 500), parseInt(offset) || 0)

    const { rows } = await query(sql, params)

    const { rows: [{ count }] } = await query(
      `SELECT COUNT(*) FROM audit_log WHERE tenant_id = $1${eventType ? ' AND event_type = $2' : ''}`,
      eventType ? [tenantId, eventType] : [tenantId]
    )

    return { data: { logs: rows, total: parseInt(count), limit: parseInt(limit), offset: parseInt(offset) } }
  })
}
