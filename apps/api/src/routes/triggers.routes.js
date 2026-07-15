// apps/api/src/routes/triggers.routes.js
// Ambient / proactive workflow trigger management
// POST /tenants/:tenantId/triggers          — create a trigger
// GET  /tenants/:tenantId/triggers          — list triggers
// PATCH /tenants/:tenantId/triggers/:id     — update (enable/disable/change config)
// DELETE /tenants/:tenantId/triggers/:id    — remove
// POST /tenants/:tenantId/triggers/webhook/:id — inbound webhook endpoint (no auth, uses secret)

import { query } from '../db/pool.js'
import { errorResponse, AppError } from '../utils/errors.js'
import { startWorkflowExecution } from '../services/workflow.service.js'
import { auditLog } from '../utils/audit.js'
import crypto from 'crypto'

export default async function triggersRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }

  // ── Create trigger ─────────────────────────────────────────────────────────
  fastify.post('/tenants/:tenantId/triggers', auth, async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { workflowId, triggerType, name, config = {} } = req.body

      if (!workflowId || !triggerType || !name) {
        throw new AppError('MISSING_FIELDS', 'workflowId, triggerType, and name are required', 400)
      }

      const VALID_TYPES = ['WEBHOOK', 'SCHEDULE', 'CONDITION', 'EVENT']
      if (!VALID_TYPES.includes(triggerType)) {
        throw new AppError('INVALID_TYPE', `triggerType must be one of: ${VALID_TYPES.join(', ')}`, 400)
      }

      // Auto-generate webhook secret for WEBHOOK triggers
      const finalConfig = triggerType === 'WEBHOOK'
        ? { ...config, secret: config.secret || crypto.randomBytes(24).toString('hex') }
        : config

      const { rows: [trigger] } = await query(
        `INSERT INTO workflow_triggers (tenant_id, workflow_id, trigger_type, name, config)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [tenantId, workflowId, triggerType, name, finalConfig]
      )

      await auditLog({ eventType: 'trigger.created', tenantId, actorId: req.user.sub, actorType: 'USER', resourceType: 'WorkflowTrigger', resourceId: trigger.id, action: 'CREATE_TRIGGER' })

      return reply.status(201).send({ success: true, data: trigger, meta: { timestamp: new Date().toISOString() } })
    } catch (err) { return errorResponse(reply, err) }
  })

  // ── List triggers ──────────────────────────────────────────────────────────
  fastify.get('/tenants/:tenantId/triggers', auth, async (req, reply) => {
    try {
      const { rows } = await query(
        `SELECT t.*, w.name as workflow_name FROM workflow_triggers t
         JOIN workflows w ON w.id = t.workflow_id
         WHERE t.tenant_id = $1 ORDER BY t.created_at DESC`,
        [req.params.tenantId]
      )
      return reply.send({ success: true, data: rows, meta: { timestamp: new Date().toISOString() } })
    } catch (err) { return errorResponse(reply, err) }
  })

  // ── Update trigger ─────────────────────────────────────────────────────────
  fastify.patch('/tenants/:tenantId/triggers/:id', auth, async (req, reply) => {
    try {
      const { tenantId, id } = req.params
      const updates = req.body
      const allowed = ['name', 'config', 'is_active']
      const fields = []
      const params = [tenantId, id]

      for (const [k, v] of Object.entries(updates)) {
        if (allowed.includes(k)) {
          params.push(v)
          fields.push(`${k} = $${params.length}`)
        }
      }
      if (fields.length === 0) throw new AppError('NO_FIELDS', 'No valid fields', 400)

      const { rows: [trigger] } = await query(
        `UPDATE workflow_triggers SET ${fields.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        params
      )
      if (!trigger) throw new AppError('NOT_FOUND', 'Trigger not found', 404)
      return reply.send({ success: true, data: trigger, meta: { timestamp: new Date().toISOString() } })
    } catch (err) { return errorResponse(reply, err) }
  })

  // ── Delete trigger ─────────────────────────────────────────────────────────
  fastify.delete('/tenants/:tenantId/triggers/:id', auth, async (req, reply) => {
    try {
      await query(
        'DELETE FROM workflow_triggers WHERE id = $1 AND tenant_id = $2',
        [req.params.id, req.params.tenantId]
      )
      return reply.send({ success: true, data: null, meta: { timestamp: new Date().toISOString() } })
    } catch (err) { return errorResponse(reply, err) }
  })

  // ── Duplicate trigger ──────────────────────────────────────────────────────
  fastify.post('/tenants/:tenantId/triggers/:id/duplicate', auth, async (req, reply) => {
    try {
      const { tenantId, id } = req.params
      const { rows: [src] } = await query(
        `SELECT * FROM workflow_triggers WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      )
      if (!src) throw new AppError('NOT_FOUND', 'Trigger not found', 404)

      // For webhooks, generate a fresh secret rather than reusing the source's
      const cfg = { ...src.config }
      if (src.trigger_type === 'WEBHOOK') {
        cfg.secret = crypto.randomBytes(24).toString('hex')
      }

      const { rows: [clone] } = await query(
        `INSERT INTO workflow_triggers (tenant_id, workflow_id, trigger_type, name, config, is_active)
         VALUES ($1, $2, $3, $4, $5, false) RETURNING *`,
        [tenantId, src.workflow_id, src.trigger_type, `${src.name} (copy)`, cfg]
      )
      return reply.status(201).send({ success: true, data: clone })
    } catch (err) { return errorResponse(reply, err) }
  })

  // ── Inbound webhook endpoint ───────────────────────────────────────────────
  // POST /tenants/:tenantId/triggers/webhook/:triggerId
  // No auth — verified via HMAC signature in X-Kuvalam-Signature header
  fastify.post('/tenants/:tenantId/triggers/webhook/:triggerId', async (req, reply) => {
    try {
      const { tenantId, triggerId } = req.params

      const { rows: [trigger] } = await query(
        `SELECT t.*, w.id as wf_id FROM workflow_triggers t
         JOIN workflows w ON w.id = t.workflow_id
         WHERE t.id = $1 AND t.tenant_id = $2 AND t.trigger_type = 'WEBHOOK' AND t.is_active = TRUE`,
        [triggerId, tenantId]
      )
      if (!trigger) return reply.status(404).send({ success: false, error: 'Trigger not found or inactive' })

      // ✅ FIX 1: Enforce HMAC signature verification
      const secret = trigger.config?.secret
      const signature = req.headers['x-kuvalam-signature']
      
      if (!secret) {
        return reply.status(500).send({ 
          success: false, 
          error: 'Webhook misconfigured - no secret available' 
        })
      }

      if (!signature) {
        return reply.status(401).send({ 
          success: false, 
          error: 'X-Kuvalam-Signature header required. Sign request body with HMAC-SHA256.' 
        })
      }

      const expected = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex')
      
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return reply.status(401).send({ 
          success: false, 
          error: 'Invalid signature. Verify your HMAC secret and signing process.' 
        })
      }

      // Fire the workflow
      await startWorkflowExecution(tenantId, trigger.wf_id, { ...req.body, triggerId, triggerType: 'WEBHOOK' })
      await query(
        `UPDATE workflow_triggers SET last_fired_at = NOW(), fire_count = fire_count + 1 WHERE id = $1`,
        [triggerId]
      )

      return reply.send({ success: true, data: { fired: true }, meta: { timestamp: new Date().toISOString() } })
    } catch (err) { return errorResponse(reply, err) }
  })
}
