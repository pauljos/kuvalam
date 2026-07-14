// apps/api/src/routes/approvals.routes.js
import { query } from '../db/pool.js'
import { AppError, errorResponse } from '../utils/errors.js'
import { auditLog } from '../utils/audit.js'

export default async function approvalsRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate)

  // List approval requests for tenant
  fastify.get('/tenants/:tenantId/approvals', async (req, reply) => {
    const { tenantId } = req.params
    const { status, limit = 50, offset = 0 } = req.query

    let sql = `SELECT * FROM approval_requests WHERE tenant_id = $1`
    const params = [tenantId]

    if (status) {
      params.push(status)
      sql += ` AND status = $${params.length}`
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(limit, offset)

    const { rows } = await query(sql, params)
    const { rows: [{ count }] } = await query(
      `SELECT COUNT(*) FROM approval_requests WHERE tenant_id = $1${status ? ' AND status = $2' : ''}`,
      status ? [tenantId, status] : [tenantId]
    )

    return { data: { approvals: rows, total: parseInt(count), limit, offset } }
  })

  // Get single approval request
  fastify.get('/tenants/:tenantId/approvals/:approvalId', async (req, reply) => {
    const { tenantId, approvalId } = req.params
    const { rows: [approval] } = await query(
      `SELECT * FROM approval_requests WHERE id = $1 AND tenant_id = $2`,
      [approvalId, tenantId]
    )
    if (!approval) throw new AppError('APPROVAL_NOT_FOUND', 'Approval request not found', 404)
    return { data: approval }
  })

  // Decide on approval request (APPROVED or REJECTED)
  fastify.post('/tenants/:tenantId/approvals/:approvalId/decide', async (req, reply) => {
    const { tenantId, approvalId } = req.params
    const { decision, decisionNote } = req.body

    if (!['APPROVED', 'REJECTED'].includes(decision)) {
      throw new AppError('INVALID_DECISION', 'Decision must be APPROVED or REJECTED', 400)
    }

    const { rows: [approval] } = await query(
      `SELECT * FROM approval_requests WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING'`,
      [approvalId, tenantId]
    )
    if (!approval) throw new AppError('APPROVAL_NOT_PENDING', 'Approval request is not pending or does not exist', 404)

    // Update approval record
    const { rows: [updated] } = await query(
      `UPDATE approval_requests
       SET status = $1, decided_by = $2, decided_at = NOW(), decision_note = $3
       WHERE id = $4
       RETURNING *`,
      [decision, req.user.id, decisionNote || null, approvalId]
    )

    // If linked to a workflow execution, resume it
    if (approval.execution_id) {
      try {
        const { resumeWorkflowExecution } = await import('../services/workflow.service.js')
        await resumeWorkflowExecution(tenantId, approval.execution_id, {
          approved: decision === 'APPROVED',
          notes: decisionNote
        })
      } catch (err) {
        fastify.log.error(`Failed to resume workflow execution ${approval.execution_id}: ${err.message}`)
      }
    }

    await auditLog({
      tenantId, eventType: 'approval.decided', actorId: req.user.id, actorType: 'USER',
      resourceType: 'ApprovalRequest', resourceId: approvalId,
      action: `APPROVAL_${decision}`
    })

    return { data: updated }
  })
}
