// apps/api/src/routes/approvals.routes.js
// HITL Approval Routes — enhanced with task resume, timeout handling, and modified input support
import { query } from '../db/pool.js'
import { AppError, errorResponse } from '../utils/errors.js'
import { auditLog } from '../utils/audit.js'
import { handleApprovalDecision, autoRejectExpiredApprovals } from '../services/hitl.service.js'

const ts = () => ({ requestId: undefined, timestamp: new Date().toISOString() })

export default async function approvalsRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate)

  // List approval requests for tenant
  fastify.get('/tenants/:tenantId/approvals', async (req, reply) => {
    const { tenantId } = req.params
    const { status, limit = 50, offset = 0 } = req.query

    let sql = `SELECT a.*, ag.name as agent_name, t.goal as task_goal
               FROM approval_requests a
               LEFT JOIN agents ag ON ag.id = a.agent_id
               LEFT JOIN agent_tasks t ON t.id = a.task_id
               WHERE a.tenant_id = $1`
    const params = [tenantId]

    if (status) {
      params.push(status)
      sql += ` AND a.status = $${params.length}`
    }

    sql += ` ORDER BY a.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(limit, offset)

    const { rows } = await query(sql, params)
    const { rows: [{ count }] } = await query(
      `SELECT COUNT(*) FROM approval_requests WHERE tenant_id = $1${status ? ' AND status = $2' : ''}`,
      status ? [tenantId, status] : [tenantId]
    )

    return { success: true, data: { approvals: rows, total: parseInt(count), limit, offset }, meta: ts() }
  })

  // Get single approval request (with full task context)
  fastify.get('/tenants/:tenantId/approvals/:approvalId', async (req, reply) => {
    const { tenantId, approvalId } = req.params
    const { rows: [approval] } = await query(
      `SELECT a.*, ag.name as agent_name, ag.autonomy_level as agent_autonomy,
              t.goal as task_goal, t.status as task_status, t.context as task_context
       FROM approval_requests a
       LEFT JOIN agents ag ON ag.id = a.agent_id
       LEFT JOIN agent_tasks t ON t.id = a.task_id
       WHERE a.id = $1 AND a.tenant_id = $2`,
      [approvalId, tenantId]
    )
    if (!approval) throw new AppError('APPROVAL_NOT_FOUND', 'Approval request not found', 404)
    return { success: true, data: approval, meta: ts() }
  })

  // Decide on approval request (APPROVED or REJECTED) — with task resume support
  fastify.post('/tenants/:tenantId/approvals/:approvalId/decide', async (req, reply) => {
    const { tenantId, approvalId } = req.params
    const { decision, decisionNote, modifiedInput } = req.body

    if (!['APPROVED', 'REJECTED'].includes(decision)) {
      throw new AppError('INVALID_DECISION', 'Decision must be APPROVED or REJECTED', 400)
    }

    try {
      const updated = await handleApprovalDecision({
        tenantId,
        approvalId,
        decision,
        decisionNote,
        decidedBy: req.user.id,
        modifiedInput,
        isSystemAdmin: req.user.isSystemAdmin === true,
      })

      return { success: true, data: updated, meta: ts() }
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // Revert an APPROVED/REJECTED approval back to PENDING so it can be re-actioned
  fastify.post('/tenants/:tenantId/approvals/:approvalId/revert', async (req, reply) => {
    const { tenantId, approvalId } = req.params
    const { rows: [approval] } = await query(
      `SELECT * FROM approval_requests WHERE id = $1 AND tenant_id = $2`,
      [approvalId, tenantId]
    )
    if (!approval) throw new AppError('NOT_FOUND', 'Approval not found', 404)
    if (approval.status === 'PENDING') throw new AppError('ALREADY_PENDING', 'Approval is already pending', 400)
    await query(
      `UPDATE approval_requests SET status = 'PENDING', decided_by = NULL, decided_at = NULL, decision_note = NULL, modified_input = NULL WHERE id = $1`,
      [approvalId]
    )
    await auditLog({ eventType: 'approval.reverted', tenantId, actorId: req.user.id, actorType: 'USER', resourceType: 'ApprovalRequest', resourceId: approvalId, action: 'APPROVAL_REVERT', afterState: { previousStatus: approval.status } })
    return { success: true, data: { id: approvalId, status: 'PENDING' }, meta: ts() }
  })

  // Auto-reject expired approvals (admin/maintenance endpoint)
  fastify.post('/tenants/:tenantId/approvals/cleanup', async (req, reply) => {
    try {
      const count = await autoRejectExpiredApprovals()
      return { success: true, data: { autoRejected: count }, meta: ts() }
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // Batch approve/reject multiple pending approvals
  fastify.post('/tenants/:tenantId/approvals/batch', async (req, reply) => {
    const { tenantId } = req.params
    const { approvalIds, decision, decisionNote } = req.body

    if (!Array.isArray(approvalIds) || approvalIds.length === 0) {
      throw new AppError('INVALID_INPUT', 'approvalIds must be a non-empty array', 400)
    }
    if (!['APPROVED', 'REJECTED'].includes(decision)) {
      throw new AppError('INVALID_DECISION', 'Decision must be APPROVED or REJECTED', 400)
    }

    const results = []
    const errors = []

    for (const approvalId of approvalIds) {
      try {
        const updated = await handleApprovalDecision({
          tenantId,
          approvalId,
          decision,
          decisionNote,
          decidedBy: req.user.id,
          isSystemAdmin: req.user.isSystemAdmin === true,
        })
        results.push(updated)
      } catch (err) {
        errors.push({ approvalId, error: err.message })
      }
    }

    return {
      success: true,
      data: { processed: results.length, succeeded: results.length, failed: errors.length, results, errors },
      meta: ts(),
    }
  })
}
