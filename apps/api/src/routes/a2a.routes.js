// apps/api/src/routes/a2a.routes.js
// Agent-to-Agent (A2A) Protocol — Google open standard
// Exposes each agent as a callable endpoint so external agents can delegate tasks.
// Also provides a built-in a2a_call tool that agents can use to invoke remote agents.
//
// Spec: https://google.github.io/A2A/
//
// Endpoints:
//   GET  /a2a/tenants/:tenantId/agents/:agentId          — Agent Card (capability discovery)
//   POST /a2a/tenants/:tenantId/agents/:agentId/tasks    — Submit a task (returns taskId)
//   GET  /a2a/tenants/:tenantId/agents/:agentId/tasks/:taskId — Poll task result
//
// Auth: Bearer token (same JWT) OR tenant-scoped API key (future)

import { query } from '../db/pool.js'
import { errorResponse, AppError } from '../utils/errors.js'
import { dispatchTask, getTask } from '../services/task.service.js'

export default async function a2aRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }

  // ── Agent Card (capability discovery) ─────────────────────────────────────
  // Returns machine-readable description of what the agent can do
  fastify.get('/a2a/tenants/:tenantId/agents/:agentId', auth, async (req, reply) => {
    try {
      const { tenantId, agentId } = req.params
      const { rows: [agent] } = await query(
        `SELECT a.*, 
           (SELECT json_agg(row_to_json(s)) FROM agent_skills s WHERE s.agent_id = a.id AND s.is_enabled = true) as skills
         FROM agents a WHERE a.id = $1 AND a.tenant_id = $2 AND a.status = 'ACTIVE'`,
        [agentId, tenantId]
      )
      if (!agent) throw new AppError('AGENT_NOT_FOUND', 'Agent not found or not active', 404)

      // A2A Agent Card format
      const card = {
        schemaVersion: '0.2',
        name: agent.name,
        description: agent.description || '',
        url: `${process.env.API_BASE_URL || 'http://localhost:3001'}/api/v1/a2a/tenants/${tenantId}/agents/${agentId}`,
        version: '1.0',
        capabilities: {
          streaming: true,
          pushNotifications: false,
          stateTransitionHistory: true
        },
        skills: (agent.skills || []).map(s => ({
          id: s.name.replace(/\s+/g, '_').toLowerCase(),
          name: s.name,
          description: s.description || ''
        })),
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        authentication: { schemes: ['bearer'] }
      }

      return reply.send(card)
    } catch (err) { return errorResponse(reply, err) }
  })

  // ── Submit task to an agent ────────────────────────────────────────────────
  fastify.post('/a2a/tenants/:tenantId/agents/:agentId/tasks', auth, async (req, reply) => {
    try {
      const { tenantId, agentId } = req.params
      const { message, sessionId, metadata = {} } = req.body

      // A2A message format: { role: 'user', parts: [{ text: '...' }] }
      const goal = message?.parts?.map(p => p.text || '').join(' ') || message?.text || ''
      if (!goal.trim()) throw new AppError('MISSING_GOAL', 'message.parts[].text is required', 400)

      const result = await dispatchTask({
        tenantId,
        agentId,
        goal,
        context: { a2aSessionId: sessionId, ...metadata },
        userId: req.user.sub
      })

      // A2A Task response format
      return reply.status(202).send({
        id: result.taskId,
        sessionId,
        status: { state: 'submitted', timestamp: new Date().toISOString() },
        metadata: { agentId, tenantId }
      })
    } catch (err) { return errorResponse(reply, err) }
  })

  // ── Poll task result ───────────────────────────────────────────────────────
  fastify.get('/a2a/tenants/:tenantId/agents/:agentId/tasks/:taskId', auth, async (req, reply) => {
    try {
      const { tenantId, agentId, taskId } = req.params
      const task = await getTask(tenantId, taskId)

      const stateMap = {
        QUEUED: 'submitted', RUNNING: 'working',
        COMPLETED: 'completed', FAILED: 'failed'
      }

      const artifacts = task.result ? [{
        name: 'result',
        parts: [{ type: 'text', text: task.result?.output || task.result?.summary || JSON.stringify(task.result) }]
      }] : []

      return reply.send({
        id: taskId,
        status: {
          state: stateMap[task.status] || 'working',
          timestamp: (task.completed_at || task.started_at || task.created_at)
        },
        artifacts,
        metadata: { tokensUsed: task.token_usage, confidence: task.result?.confidence }
      })
    } catch (err) { return errorResponse(reply, err) }
  })
}
