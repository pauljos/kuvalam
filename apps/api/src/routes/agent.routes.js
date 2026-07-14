// apps/api/src/routes/agent.routes.js
import * as agentService from '../services/agent.service.js'
import * as taskService from '../services/task.service.js'
import { errorResponse, AppError } from '../utils/errors.js'

// In-memory per-tenant task dispatch rate limiter
// Limits: max TASK_RATE_LIMIT tasks per TASK_RATE_WINDOW_MS per tenant
const TASK_RATE_LIMIT = parseInt(process.env.TASK_RATE_LIMIT || '20')
const TASK_RATE_WINDOW_MS = 60_000 // 1 minute
const tenantTaskCounts = new Map() // tenantId -> { count, windowStart }

function checkTenantTaskRateLimit(tenantId) {
  const now = Date.now()
  const entry = tenantTaskCounts.get(tenantId)

  if (!entry || now - entry.windowStart >= TASK_RATE_WINDOW_MS) {
    tenantTaskCounts.set(tenantId, { count: 1, windowStart: now })
    return
  }

  if (entry.count >= TASK_RATE_LIMIT) {
    const resetIn = Math.ceil((TASK_RATE_WINDOW_MS - (now - entry.windowStart)) / 1000)
    throw new AppError(
      'TENANT_RATE_LIMITED',
      `Task dispatch limit of ${TASK_RATE_LIMIT} per minute reached. Retry in ${resetIn}s.`,
      429
    )
  }

  entry.count++
}

export default async function agentRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }

  // POST /tenants/:tenantId/agents
  fastify.post('/tenants/:tenantId/agents', auth, async (req, reply) => {
    try {
      const agent = await agentService.createAgent({ tenantId: req.params.tenantId, data: req.body, userId: req.user.sub })
      return reply.status(201).send({ success: true, data: agent, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/agents
  fastify.get('/tenants/:tenantId/agents', auth, async (req, reply) => {
    try {
      const result = await agentService.listAgents(req.params.tenantId, req.query)
      return reply.send({ success: true, data: result, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/agents/:agentId
  fastify.get('/tenants/:tenantId/agents/:agentId', auth, async (req, reply) => {
    try {
      const agent = await agentService.getAgent(req.params.tenantId, req.params.agentId)
      return reply.send({ success: true, data: agent, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // PATCH /tenants/:tenantId/agents/:agentId
  fastify.patch('/tenants/:tenantId/agents/:agentId', auth, async (req, reply) => {
    try {
      const agent = await agentService.updateAgent(req.params.tenantId, req.params.agentId, req.body, req.user.sub)
      return reply.send({ success: true, data: agent, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/agents/:agentId/activate
  fastify.post('/tenants/:tenantId/agents/:agentId/activate', auth, async (req, reply) => {
    try {
      const agent = await agentService.activateAgent(req.params.tenantId, req.params.agentId, req.user.sub)
      return reply.send({ success: true, data: agent, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/agents/:agentId/duplicate
  fastify.post('/tenants/:tenantId/agents/:agentId/duplicate', auth, async (req, reply) => {
    try {
      const src = await agentService.getAgent(req.params.tenantId, req.params.agentId)
      if (!src) throw new AppError('NOT_FOUND', 'Agent not found', 404)
      const clone = await agentService.createAgent({
        tenantId: req.params.tenantId,
        userId: req.user.sub,
        data: {
          // NOTE: createAgent expects camelCase field names — do not pass snake_case here,
          // otherwise the source agent's LLM choice, prompt and autonomy level are silently lost.
          name: `${src.name} (copy)`,
          description: src.description,
          archetype: src.archetype,
          llmProvider: src.llm_provider,
          llmModel: src.llm_model,
          systemPrompt: src.system_prompt,
          autonomyLevel: src.autonomy_level,
          confidenceThreshold: src.confidence_threshold,
          maxActionsPerRun: src.max_actions_per_run,
        },
      })
      return reply.status(201).send({ success: true, data: clone, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/agents/:agentId/skills
  fastify.post('/tenants/:tenantId/agents/:agentId/skills', auth, async (req, reply) => {
    try {
      const skill = await agentService.addSkill(req.params.tenantId, req.params.agentId, req.body, req.user.sub)
      return reply.status(201).send({ success: true, data: skill, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/agents/:agentId/rules
  fastify.post('/tenants/:tenantId/agents/:agentId/rules', auth, async (req, reply) => {
    try {
      const rule = await agentService.addRule(req.params.tenantId, req.params.agentId, req.body, req.user.sub)
      return reply.status(201).send({ success: true, data: rule, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/agents/:agentId/knowledge-bases/:kbId
  fastify.post('/tenants/:tenantId/agents/:agentId/knowledge-bases/:kbId', auth, async (req, reply) => {
    try {
      await agentService.linkKnowledgeBase(req.params.tenantId, req.params.agentId, req.params.kbId, req.user.sub)
      return reply.send({ success: true, data: { linked: true }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/agents/:agentId/tasks — dispatch a task
  fastify.post('/tenants/:tenantId/agents/:agentId/tasks', auth, async (req, reply) => {
    try {
      checkTenantTaskRateLimit(req.params.tenantId)
      const result = await taskService.dispatchTask({
        tenantId: req.params.tenantId,
        agentId: req.params.agentId,
        ...req.body,
        userId: req.user.sub
      })
      return reply.status(202).send({ success: true, data: result, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/agents/:agentId/tasks
  fastify.get('/tenants/:tenantId/agents/:agentId/tasks', auth, async (req, reply) => {
    try {
      const tasks = await taskService.listTasks(req.params.tenantId, req.params.agentId, req.query)
      return reply.send({ success: true, data: { tasks }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/agents/:agentId/tasks/:taskId
  fastify.get('/tenants/:tenantId/agents/:agentId/tasks/:taskId', auth, async (req, reply) => {
    try {
      const task = await taskService.getTask(req.params.tenantId, req.params.taskId)
      return reply.send({ success: true, data: task, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })
}

const ts = () => ({ timestamp: new Date().toISOString() })
