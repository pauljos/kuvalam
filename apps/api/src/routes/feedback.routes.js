// apps/api/src/routes/feedback.routes.js
// Human feedback on completed approvals (and by extension on the agent that ran them).
// Writes to the `human_feedback` table (schema defined in 001_initial_schema.sql).

import { query } from '../db/pool.js'
import { AppError, errorResponse } from '../utils/errors.js'
import { auditLog } from '../utils/audit.js'

export default async function feedbackRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate)

  // POST /tenants/:tenantId/feedback ─ submit rating + optional text
  fastify.post('/tenants/:tenantId/feedback', async (req, reply) => {
    try {
      const { tenantId } = req.params
      const {
        approvalId,
        agentId,
        decision = 'REVIEWED',
        qualityRating,
        feedbackText,
        tags,
      } = req.body || {}

      if (!qualityRating || qualityRating < 1 || qualityRating > 5) {
        throw new AppError('INVALID_RATING', 'qualityRating must be between 1 and 5', 400)
      }
      if (!agentId && !approvalId) {
        throw new AppError('MISSING_TARGET', 'One of agentId or approvalId is required', 400)
      }

      const { rows: [row] } = await query(
        `INSERT INTO human_feedback
           (tenant_id, approval_id, agent_id, decision, quality_rating, feedback_text, feedback_tags, decided_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, quality_rating, created_at`,
        [
          tenantId,
          approvalId || null,
          agentId || null,
          decision,
          qualityRating,
          feedbackText || null,
          tags || [],
          req.user.sub,
        ]
      )

      await auditLog({
        eventType: 'feedback.submitted',
        tenantId,
        actorId: req.user.sub,
        actorType: 'USER',
        resourceType: agentId ? 'Agent' : 'ApprovalRequest',
        resourceId: agentId || approvalId,
        action: 'SUBMIT_FEEDBACK',
        metadata: { rating: qualityRating, decision },
      })

      return reply.status(201).send({ success: true, data: row })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/feedback ─ list + aggregate (optionally filtered by agent)
  fastify.get('/tenants/:tenantId/feedback', async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { agentId } = req.query
      const params = [tenantId]
      let sql = `SELECT id, approval_id, agent_id, decision, quality_rating, feedback_text, feedback_tags, decided_by, created_at
                 FROM human_feedback WHERE tenant_id = $1`
      if (agentId) {
        params.push(agentId)
        sql += ` AND agent_id = $${params.length}`
      }
      sql += ` ORDER BY created_at DESC LIMIT 100`
      const { rows } = await query(sql, params)

      const avg = rows.length
        ? rows.reduce((n, r) => n + r.quality_rating, 0) / rows.length
        : null

      return reply.send({
        success: true,
        data: { feedback: rows, count: rows.length, avgRating: avg },
      })
    } catch (err) { return errorResponse(reply, err) }
  })
}
