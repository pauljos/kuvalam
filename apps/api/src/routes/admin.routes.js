// apps/api/src/routes/admin.routes.js
// Routes for system administrators (super-admins) to manage tenants & system health

import { query } from '../db/pool.js'
import { AppError } from '../utils/errors.js'
import { getQueueStats } from '../services/queue.service.js'
import { getSchedulerStatus } from '../services/scheduler.service.js'

export default async function adminRoutes(fastify) {

  // Guard route for system admins only — runs as a preHandler so we can enforce
  // ordering: authenticate first, then check isSystemAdmin. Using preHandler
  // (not onRequest) guarantees the route handler is skipped if either step
  // sends a reply.
  fastify.addHook('preHandler', async (req, reply) => {
    await fastify.authenticate(req, reply)
    if (reply.sent) return
    if (!req.user?.isSystemAdmin) {
      return reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'System administrator access required' }
      })
    }
  })

  /**
   * GET /api/v1/admin/tenants
   * Returns list of all tenants with user, agent, task, and workflow counts
   */
  fastify.get('/admin/tenants', async (req, reply) => {
    // We bypass RLS by querying directly without current_tenant_id set, 
    // or by running a query that counts across all schemas/tenants.
    // Note: since RLS is enabled using tenant_id = current_tenant_id(),
    // if app.current_tenant_id is not set, a regular user query would return 0 rows.
    // However, the admin queries can bypass this if they query tables or use a privileged block.
    // In our pool.js, normal query() does NOT set app.current_tenant_id, so it bypasses RLS!
    // (Only tenantQuery() sets it). This is perfect for system admin commands!
    
    const { rows: tenants } = await query(`
      SELECT 
        t.id, t.name, t.slug, t.plan, t.status, t.created_at,
        (SELECT COUNT(*)::int FROM tenant_members tm WHERE tm.tenant_id = t.id) as user_count,
        (SELECT COUNT(*)::int FROM agents a WHERE a.tenant_id = t.id) as agent_count,
        (SELECT COUNT(*)::int FROM workflows w WHERE w.tenant_id = t.id) as workflow_count,
        (SELECT COUNT(*)::int FROM agent_tasks at WHERE at.tenant_id = t.id) as task_count
      FROM tenants t
      ORDER BY t.created_at DESC
    `)

    return { data: { tenants } }
  })

  /**
   * PATCH /api/v1/admin/tenants/:tenantId
   * Updates plan or status of a tenant
   */
  fastify.patch('/admin/tenants/:tenantId', async (req, reply) => {
    const { tenantId } = req.params
    const { plan, status } = req.body

    const updates = []
    const values = []
    let idx = 1

    if (plan) {
      updates.push(`plan = $${idx++}`)
      values.push(plan)
    }
    if (status) {
      updates.push(`status = $${idx++}`)
      values.push(status)
    }

    if (updates.length === 0) {
      throw new AppError('BAD_REQUEST', 'No update fields provided', 400)
    }

    values.push(tenantId)
    const { rows: [tenant] } = await query(
      `UPDATE tenants SET ${updates.join(', ')}, updated_at = NOW() 
       WHERE id = $${idx} RETURNING id, name, slug, plan, status`,
      values
    )

    if (!tenant) {
      throw new AppError('TENANT_NOT_FOUND', 'Tenant not found', 404)
    }

    return { data: { tenant } }
  })

  /**
   * GET /api/v1/admin/system-status
   * Detailed system performance metrics, queues, scheduler status
   */
  fastify.get('/admin/system-status', async (req, reply) => {
    const queue = await getQueueStats().catch(err => ({ available: false, error: err.message }))
    const scheduler = getSchedulerStatus()

    // Get database sizing & connection count
    const { rows: dbStats } = await query(`
      SELECT 
        (SELECT count(*)::int FROM pg_stat_activity) as active_connections,
        pg_size_pretty(pg_database_size(current_database())) as database_size
    `)

    return {
      data: {
        queue,
        scheduler,
        database: dbStats[0] || { active_connections: 0, database_size: 'unknown' },
        timestamp: new Date().toISOString()
      }
    }
  })
}
