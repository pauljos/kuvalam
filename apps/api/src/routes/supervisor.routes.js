// apps/api/src/routes/supervisor.routes.js
// ═══════════════════════════════════════════════════════════════════════════
// Tenant Supervisor + Fleet Health admin routes.
// ═══════════════════════════════════════════════════════════════════════════
// - GET    /tenants/:tenantId/supervisor/health         Fleet health snapshot
// - GET    /tenants/:tenantId/supervisor/tick           Trigger a supervisor tick
// - POST   /tenants/:tenantId/supervisor/agents/:agentId/circuit/reset
//                                                       Manually close breaker
// - GET    /tenants/:tenantId/tenant-memory             List shared memory
// - DELETE /tenants/:tenantId/tenant-memory/:id         Delete an entry
// - DELETE /tenants/:tenantId/tenant-memory             Clear all
// ═══════════════════════════════════════════════════════════════════════════

import { query } from '../db/pool.js'
import { errorResponse, AppError } from '../utils/errors.js'
import { supervisorTickForTenant } from '../services/tenant-supervisor.service.js'
import {
  listTenantMemory, deleteTenantMemoryEntry, clearTenantMemory, writeTenantMemory,
} from '../services/tenant-memory.service.js'
import { auditLog } from '../utils/audit.js'

export default async function supervisorRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }
  const adminAuth = {
    preHandler: [fastify.authenticate, async (req, reply) => {
      const role = req.user?.role
      if (!['OWNER', 'ADMIN'].includes(role) && !req.user?.isSystemAdmin) {
        return reply.status(403).send({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Admin role required' },
        })
      }
    }],
  }

  // ── Fleet health snapshot ────────────────────────────────────────────────
  fastify.get('/tenants/:tenantId/supervisor/health', auth, async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { rows } = await query(
        `SELECT h.*,
                a.name AS agent_name,
                a.archetype,
                a.autonomy_level,
                a.is_tenant_supervisor
         FROM agent_health h
         JOIN agents a ON a.id = h.agent_id
         WHERE h.tenant_id = $1
         ORDER BY a.name`,
        [tenantId]
      )
      return reply.send({ success: true, data: rows })
    } catch (err) { return errorResponse(reply, err) }
  })

  // ── Trigger a supervisor tick for this tenant (admin) ────────────────────
  fastify.post('/tenants/:tenantId/supervisor/tick', adminAuth, async (req, reply) => {
    try {
      const result = await supervisorTickForTenant(req.params.tenantId)
      return reply.send({ success: true, data: result })
    } catch (err) { return errorResponse(reply, err) }
  })

  // ── Manually reset a circuit breaker ─────────────────────────────────────
  fastify.post('/tenants/:tenantId/supervisor/agents/:agentId/circuit/reset',
    adminAuth,
    async (req, reply) => {
      try {
        const { tenantId, agentId } = req.params
        const { rowCount } = await query(
          `UPDATE agent_health
           SET circuit_state = 'CLOSED', circuit_reason = NULL, circuit_opened_at = NULL, updated_at = NOW()
           WHERE agent_id = $1 AND tenant_id = $2`,
          [agentId, tenantId]
        )
        if (rowCount === 0) throw new AppError('NOT_FOUND', 'Agent health record not found', 404)
        await auditLog({
          eventType: 'agent.circuit_reset',
          tenantId, actorId: req.user.sub, actorType: 'USER',
          resourceType: 'Agent', resourceId: agentId,
          action: 'RESET_CIRCUIT', metadata: { by: req.user.sub },
        }).catch(() => {})
        return reply.send({ success: true, data: { agentId, circuit_state: 'CLOSED' } })
      } catch (err) { return errorResponse(reply, err) }
    })

  // ── Shared tenant memory ─────────────────────────────────────────────────
  fastify.get('/tenants/:tenantId/tenant-memory', auth, async (req, reply) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 100, 500)
      const offset = parseInt(req.query.offset) || 0
      const data = await listTenantMemory(req.params.tenantId, { limit, offset })
      return reply.send({ success: true, data })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST — manually add a shared memory entry (from UI)
  fastify.post('/tenants/:tenantId/tenant-memory', auth, async (req, reply) => {
    try {
      const { entityType, entityName, detail, visibility = 'TENANT' } = req.body || {}
      if (!entityType || !entityName) throw new AppError('VALIDATION_ERROR', 'entityType and entityName are required', 400)
      const entry = await writeTenantMemory(req.params.tenantId, {
        entityType: String(entityType).slice(0, 100).toUpperCase(),
        entityName: String(entityName).slice(0, 255),
        detail: detail ? String(detail).slice(0, 2000) : null,
        visibility,
        sourceAgent: null,
        sourceTask: null,
      })
      return reply.code(201).send({ success: true, data: entry })
    } catch (err) { return errorResponse(reply, err) }
  })

  fastify.delete('/tenants/:tenantId/tenant-memory/:id', adminAuth, async (req, reply) => {
    try {
      const ok = await deleteTenantMemoryEntry(req.params.tenantId, req.params.id)
      if (!ok) throw new AppError('NOT_FOUND', 'Memory entry not found', 404)
      return reply.send({ success: true, data: { deleted: true } })
    } catch (err) { return errorResponse(reply, err) }
  })

  fastify.delete('/tenants/:tenantId/tenant-memory', adminAuth, async (req, reply) => {
    try {
      const count = await clearTenantMemory(req.params.tenantId)
      return reply.send({ success: true, data: { deleted: count } })
    } catch (err) { return errorResponse(reply, err) }
  })
}
