import { query } from '../db/pool.js'
import { saveReport } from '../services/reports.service.js'
import { deleteTask } from '../services/agent.service.js'
import { errorResponse } from '../utils/errors.js'

const ts = () => ({ requestId: undefined, timestamp: new Date().toISOString() })

export default async function taskOutputsRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }

  // GET /api/v1/tenants/:tenantId/task-outputs — list completed agent task outputs
  fastify.get('/tenants/:tenantId/task-outputs', auth, async (request, reply) => {
    try {
      const { status, page = 1, pageSize = 50, agentId } = request.query
      const conditions = ['t.tenant_id = $1']
      const params = [request.params.tenantId]

      // Default to COMPLETED unless a specific status is requested
      if (status) {
        conditions.push(`t.status = $${params.length + 1}`)
        params.push(status)
      } else {
        conditions.push(`t.status = $${params.length + 1}`)
        params.push('COMPLETED')
      }

      // Optional agent filter
      if (agentId) {
        conditions.push(`t.agent_id = $${params.length + 1}`)
        params.push(agentId)
      }

      const offset = (Number(page) - 1) * Number(pageSize)

      const { rows } = await query(
        `SELECT t.id, t.agent_id, t.goal, t.result, t.status, t.created_at, t.completed_at,
                a.name as agent_name, a.archetype as agent_archetype
         FROM agent_tasks t
         LEFT JOIN agents a ON t.agent_id = a.id
         WHERE ${conditions.join(' AND ')}
         ORDER BY t.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, Number(pageSize), offset]
      )

      // Add secondary count query for pagination
      const { rows: countRows } = await query(
        `SELECT COUNT(*) as total FROM agent_tasks t WHERE ${conditions.join(' AND ')}`,
        params
      )

      return reply.send({
        success: true,
        data: {
          outputs: rows.map(r => ({
            id: r.id,
            agentId: r.agent_id,
            agentName: r.agent_name,
            agentArchetype: r.agent_archetype,
            goal: r.goal,
            summary: r.result?.summary || r.result?.output || null,
            confidence: r.result?.confidence || null,
            status: r.status,
            createdAt: r.created_at,
            completedAt: r.completed_at
          })),
          total: parseInt(countRows[0]?.total || '0', 10),
          page: Number(page),
          pageSize: Number(pageSize)
        }
      })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // DELETE /api/v1/tenants/:tenantId/task-outputs/:taskId — delete a task and its output
  fastify.delete('/tenants/:tenantId/task-outputs/:taskId', auth, async (request, reply) => {
    try {
      const { tenantId, taskId } = request.params

      // Look up the agent so we can call deleteTask (which requires agentId for FK safety)
      const { rows } = await query(
        `SELECT agent_id FROM agent_tasks WHERE id = $1 AND tenant_id = $2`,
        [taskId, tenantId]
      )
      if (rows.length === 0) {
        return reply.status(404).send({ success: false, error: { message: 'Task not found' } })
      }

      await deleteTask(tenantId, rows[0].agent_id, taskId, request.user.sub || request.user.id)
      return reply.send({ success: true, meta: ts() })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // POST /api/v1/tenants/:tenantId/task-outputs/:taskId/pin — pin a task output to dashboard reports
  fastify.post('/tenants/:tenantId/task-outputs/:taskId/pin', auth, async (request, reply) => {
    try {
      const { taskId, tenantId } = request.params

      // Fetch the task with agent info
      const { rows } = await query(
        `SELECT t.*, a.name as agent_name, a.id as agent_id
         FROM agent_tasks t
         LEFT JOIN agents a ON t.agent_id = a.id
         WHERE t.id = $1 AND t.tenant_id = $2`,
        [taskId, tenantId]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ success: false, error: { message: 'Task not found' } })
      }

      const task = rows[0]

      if (!task.result || !task.result.output) {
        return reply.status(400).send({ success: false, error: { message: 'Task has no output to pin' } })
      }

      // Build a report from the task output
      const reportTitle = request.body?.title || task.goal.slice(0, 80)
      const outputContent = task.result.output
      const agentId = task.agent_id

      // Try to extract HTML from output first, otherwise wrap in a simple container
      let htmlContent
      if (/<div|<table|<h[1-6]|<p|<ul|<ol|<section|<article/i.test(outputContent)) {
        htmlContent = outputContent
      } else {
        // Convert plain text to a simple HTML report
        const escapedOutput = outputContent
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>')
        htmlContent = `<div style="font-family: system-ui, sans-serif; padding: 20px; color: #1e293b; line-height: 1.6; white-space: pre-wrap;">${escapedOutput}</div>`
      }

      const finalHtml = `
        <div style="font-family: system-ui, sans-serif; padding: 20px; background: #ffffff; border-radius: 12px; color: #1e293b; border: 1px solid #e2e8f0;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; border-bottom: 1px solid #f1f5f9; padding-bottom: 12px;">
            <div>
              <h2 style="font-size: 18px; font-weight: 700; color: #0f172a; margin: 0;">${reportTitle}</h2>
              <p style="font-size: 12px; color: #64748b; margin: 4px 0 0 0;">Generated by ${task.agent_name || 'Unknown Agent'} • ${new Date().toLocaleDateString()}</p>
            </div>
            <span style="background: #e0f2fe; color: #0369a1; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600;">Pinned Report</span>
          </div>
          ${htmlContent}
        </div>
      `

      const report = await saveReport(tenantId, agentId, reportTitle, finalHtml)

      return reply.send({ success: true, data: { report } })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })
}
