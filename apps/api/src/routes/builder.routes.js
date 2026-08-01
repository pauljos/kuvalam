// apps/api/src/routes/builder.routes.js
// AI Builder Chatbot routes — conversational resource creation
// POST /tenants/:tenantId/builder/chat      — send a message, get LLM response + actions
// GET  /tenants/:tenantId/builder/context   — get the tenant context (LLMs, agents, etc.)

import { builderChat } from '../services/builder.service.js'
import { errorResponse } from '../utils/errors.js'
import { requireAuth, requirePermission } from '../middleware/rbac.js'

export default async function builderRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }

  // ── Chat endpoint (all authenticated users, including VIEWERs) ────────────
  fastify.post('/tenants/:tenantId/builder/chat', auth, async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { message, history, attachments } = req.body || {}

      if (!message || typeof message !== 'string' || message.trim().length < 3) {
        return reply.status(400).send({
          error: { code: 'INVALID_MESSAGE', message: 'Message must be at least 3 characters.' }
        })
      }

      const result = await builderChat({
        tenantId,
        userId: req.user.sub,
        message: message.trim(),
        history: history || [],
        attachments: attachments || [],
        userRole: req.user.role,
        isSystemAdmin: req.user.isSystemAdmin || false,
      })

      return reply.send({ success: true, data: result, meta: { timestamp: new Date().toISOString() } })
    } catch (err) {
      if (err.message === 'LLM_NOT_CONFIGURED') {
        return reply.status(400).send({
          error: {
            code: 'LLM_NOT_CONFIGURED',
            message: 'No LLM provider configured. Please set up an API key in Settings > LLM Configuration first.'
          }
        })
      }
      return errorResponse(reply, err)
    }
  })

  // ── Context endpoint (all authenticated users, including VIEWERs) ──────────
  fastify.get('/tenants/:tenantId/builder/context', auth, async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { query } = await import('../db/pool.js')

      // LLM config
      const { rows: [tenant] } = await query(
        'SELECT llm_config FROM tenants WHERE id = $1', [tenantId]
      )
      const llmConfig = tenant?.llm_config || {}
      const providers = Object.keys(llmConfig?.providers || {})
      const defaultProvider = llmConfig?.defaultProvider || providers[0] || null

      // Counts for summary
      const { rows: [counts] } = await query(
        `SELECT
          (SELECT COUNT(*) FROM agents WHERE tenant_id = $1 AND status != 'ARCHIVED') as agents,
          (SELECT COUNT(*) FROM workflows WHERE tenant_id = $1 AND status != 'ARCHIVED') as workflows,
          (SELECT COUNT(*) FROM tool_connections WHERE tenant_id = $1) as connectors,
          (SELECT COUNT(*) FROM knowledge_bases WHERE tenant_id = $1) as knowledge_bases,
          (SELECT COUNT(*) FROM workflow_triggers WHERE tenant_id = $1) as triggers`,
        [tenantId]
      )

      return reply.send({
        success: true,
        data: {
          hasLlm: providers.length > 0,
          defaultProvider,
          providers: providers.map(p => ({
            name: p,
            model: llmConfig.providers[p]?.model || 'not set',
            isDefault: p === defaultProvider,
          })),
          counts: {
            agents: parseInt(counts?.agents || 0),
            workflows: parseInt(counts?.workflows || 0),
            connectors: parseInt(counts?.connectors || 0),
            knowledgeBases: parseInt(counts?.knowledge_bases || 0),
            triggers: parseInt(counts?.triggers || 0),
          },
        },
        meta: { timestamp: new Date().toISOString() },
      })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // ── Quick-gen agent (requires agent:create permission) ──────────────────────
  fastify.post('/tenants/:tenantId/builder/quick-agent', {
    preHandler: [fastify.authenticate, requirePermission('agent:create')]
  }, async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { prompt } = req.body || {}

      if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
        return reply.status(400).send({
          error: { code: 'INVALID_PROMPT', message: 'Prompt must be at least 10 characters.' }
        })
      }

      // Use the builder chat to create the agent
      const result = await builderChat({
        tenantId,
        userId: req.user.sub,
        message: `Create an agent that: ${prompt.trim()}. Please create it now using the create_agent function.`,
        history: [],
        userRole: req.user.role,
        isSystemAdmin: req.user.isSystemAdmin || false,
      })

      return reply.send({ success: true, data: result, meta: { timestamp: new Date().toISOString() } })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // ── Quick-gen workflow (requires workflow:create permission) ────────────────
  fastify.post('/tenants/:tenantId/builder/quick-workflow', {
    preHandler: [fastify.authenticate, requirePermission('workflow:create')]
  }, async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { prompt } = req.body || {}

      if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
        return reply.status(400).send({
          error: { code: 'INVALID_PROMPT', message: 'Prompt must be at least 10 characters.' }
        })
      }

      const result = await builderChat({
        tenantId,
        userId: req.user.sub,
        message: `Create a workflow that: ${prompt.trim()}. Please create it now using the create_workflow function with appropriate steps.`,
        history: [],
        userRole: req.user.role,
        isSystemAdmin: req.user.isSystemAdmin || false,
      })

      return reply.send({ success: true, data: result, meta: { timestamp: new Date().toISOString() } })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })
}
