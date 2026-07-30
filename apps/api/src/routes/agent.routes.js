// apps/api/src/routes/agent.routes.js
import * as agentService from '../services/agent.service.js'
import * as taskService from '../services/task.service.js'
import * as scopeService from '../services/agent-scope.service.js'
import { executeCustomSkill } from '../services/skill-executor.service.js'
import { errorResponse, AppError } from '../utils/errors.js'
import { requireAdmin, requirePermission } from '../middleware/rbac.js'
import { 
  uuidParam, 
  agentIdParam, 
  createAgentSchema, 
  updateAgentSchema, 
  dispatchTaskSchema,
  addSkillSchema 
} from '../schemas/validation.js'

// // ── Task Rate Limiting — Redis-backed, falls back to in-memory ─────────────────
// The original in-memory Map reset on server restart and was wrong in multi-
// instance deployments. Redis INCR+EXPIRE gives a shared, persistent counter
// across all instances without requiring a lock.

const TASK_RATE_WINDOW_MS = 60_000 // 1 minute
const TASK_RATE_WINDOW_S  = 60     // same, in seconds (for Redis EXPIRE)

// Fallback in-memory counter (used when Redis is unavailable)
const tenantTaskCounts = new Map()
const TASK_RATE_CACHE_MAX = 10_000

async function resolveTaskRateLimit(tenantId) {
  const { getTaskRateLimit } = await import('../services/plan-limits.service.js')
  return getTaskRateLimit(tenantId)
}

async function checkTenantTaskRateLimit(tenantId) {
  const limit = await resolveTaskRateLimit(tenantId)

  // ── Redis path (preferred) ──────────────────────────────────────────────
  try {
    const { getRedisConnection } = await import('../services/queue.service.js')
    const redis = getRedisConnection()
    const key = `rate:tasks:${tenantId}`
    const count = await redis.incr(key)
    if (count === 1) {
      // First call in this window — set TTL so the key auto-expires
      await redis.expire(key, TASK_RATE_WINDOW_S)
    }
    if (count > limit) {
      // Get remaining TTL so we can tell the user when to retry
      const ttl = await redis.ttl(key)
      throw new AppError(
        'TENANT_RATE_LIMITED',
        `Task dispatch limit of ${limit} per minute reached. Retry in ${ttl > 0 ? ttl : 60}s.`,
        429
      )
    }
    return // Redis check passed
  } catch (err) {
    if (err.code === 'TENANT_RATE_LIMITED') throw err // re-throw rate limit errors
    // Redis unavailable — fall through to in-memory fallback
  }

  // ── In-memory fallback ──────────────────────────────────────────────────
  const now = Date.now()
  const entry = tenantTaskCounts.get(tenantId)

  if (!entry || now - entry.windowStart >= TASK_RATE_WINDOW_MS) {
    if (!entry && tenantTaskCounts.size >= TASK_RATE_CACHE_MAX) {
      const oldest = tenantTaskCounts.keys().next().value
      if (oldest !== undefined) tenantTaskCounts.delete(oldest)
    }
    tenantTaskCounts.set(tenantId, { count: 1, windowStart: now, limit })
    return
  }

  if (entry.count >= entry.limit) {
    const resetIn = Math.ceil((TASK_RATE_WINDOW_MS - (now - entry.windowStart)) / 1000)
    throw new AppError(
      'TENANT_RATE_LIMITED',
      `Task dispatch limit of ${entry.limit} per minute reached. Retry in ${resetIn}s.`,
      429
    )
  }

  entry.count++
}

export default async function agentRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }
  const adminAuth = { preHandler: [fastify.authenticate, requireAdmin] }

  // POST /tenants/:tenantId/agents
  fastify.post('/tenants/:tenantId/agents', {
    schema: { params: uuidParam, ...createAgentSchema },
    preHandler: [fastify.authenticate, requirePermission('agent:create')]
  }, async (req, reply) => {
    try {
      const agent = await agentService.createAgent({ tenantId: req.params.tenantId, data: req.body, userId: req.user.sub })
      return reply.status(201).send({ success: true, data: agent, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/agents/generate — AI-powered agent creation
  // Body: { prompt: string }
  // Returns: { name, description, archetype, systemPrompt, autonomyLevel, suggestedTools }
  fastify.post('/tenants/:tenantId/agents/generate', {
    preHandler: [fastify.authenticate, requirePermission('agent:create')]
  }, async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { prompt } = req.body || {}

      if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
        return reply.status(400).send({ error: { code: 'INVALID_PROMPT', message: 'Prompt must be at least 10 characters.' } })
      }

      const systemPrompt = `You are an agent designer for the Kuvalam AI agent platform. Given a user's description of what they want an agent to do, generate a JSON object with:
- "name": A short, memorable name for this agent (max 40 chars)
- "description": A one-line summary of the agent's purpose and capabilities
- "archetype": One of: planner, research, compliance, document, communication, analytics, coordinator
- "systemPrompt": Detailed instructions for the agent (200-600 words). Include:
  * The agent's role and primary objective
  * Step-by-step operating procedure
  * Key rules and constraints
  * Tool usage guidance (when to call tools vs when to reason)
  * Error handling behavior
  * Output format expectations
- "autonomyLevel": One of: SUPERVISED, GUARDED, AUTONOMOUS
  * SUPERVISED: agent asks for approval before taking any external action
  * GUARDED: agent can take low-risk actions autonomously, asks for high-risk
  * AUTONOMOUS: agent operates freely (for internal/cron tasks)
- "suggestedTools": Array of tool names this agent should have access to.

Available system tools:
  list_tables, describe_table, query (SQL), run_query, read_file, write_file, list_files, search_files, browse_url, browser_use, web_search, calculator, clock, email_send, slack_send_message, publish_dashboard_report

Available connector tools (if tenant has them configured):
  slack__post_message, gmail__send_email, discord__send_message, twilio__send_sms, sendgrid__send_email, jira__create_issue, jira__search_issues, github__get_repo, github__create_issue, github__list_prs, mqtt__subscribe, mqtt__publish, thingsboard__telemetry, aws__s3_list, aws__cloudwatch_metrics, prometheus__query_range, prometheus__query, datadog__metrics_query, elasticsearch__search, snowflake__query, k8s__get, k8s__list, terraform__plan, terraform__apply, docker__ps, ssh__exec, service_now__get_incident, service_now__create_incident, zendesk__list_tickets, zendesk__create_ticket, salesforce__query, salesforce__create_record, hubspot__get_contacts, stripe__list_charges, stripe__refund, confluence__create_page, confluence__search, db__query

Rules:
- Match the archetype to the described role. Use "analytics" for data/reporting, "coordinator" for automation/orchestration, "communication" for messaging/support, "compliance" for audits/scans, "planner" for project/task management, "research" for investigation/synthesis, "document" for content/writing.
- For DB/data agents ALWAYS include list_tables, describe_table, query in suggestedTools.
- For browser/web agents ALWAYS include browser_use, browse_url.
- For notification/messaging agents include the relevant connector tools.
- System prompt should be practical, action-oriented, and include concrete tool-calling patterns.
- Return ONLY valid JSON — no markdown, no backticks, no explanation.`

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Create an agent that: ${prompt.trim()}` },
      ]

      // Get tenant LLM config
      const { query: dbQuery } = await import('../db/pool.js')
      const { rows } = await dbQuery(
        'SELECT llm_config FROM tenants WHERE id = $1',
        [tenantId]
      )
      const llmConfig = rows?.[0]?.llm_config || {}

      const { complete } = await import('../services/llm.service.js')

      const result = await complete({
        tenantId,
        agentId: 'agent-generator',
        messages,
        llmConfig,
        useSystemLlm: true,
        temperature: 0.2,
        goal: `Generate agent from prompt: ${prompt.trim().slice(0, 80)}`,
      })

      // Parse the LLM response as JSON
      const text = (result.content || '').trim()
      let parsed
      try {
        const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        parsed = JSON.parse(clean)
      } catch {
        return reply.status(422).send({
          error: { code: 'PARSE_ERROR', message: 'Failed to parse generated agent. Please try rephrasing your prompt.', raw: text.slice(0, 500) }
        })
      }

      const resolvedName        = parsed.name || 'AI Generated Agent'
      const resolvedDescription = parsed.description || `AI-generated agent: ${prompt.trim().slice(0, 60)}…`
      const resolvedArchetype   = parsed.archetype || 'coordinator'

      // ── Enrich system prompt with our shared archetype template ──────────
      // The LLM often produces a generic "You are X" prompt. Use our structured
      // archetype template unless the LLM produced something substantially better
      // (>300 chars with clear HOW-TO-WORK instructions).
      const { generateAgentSystemPrompt } = await import('../services/agent.service.js')
      const llmPrompt = (parsed.systemPrompt || '').trim()
      const resolvedSystemPrompt = llmPrompt.length >= 300
        ? llmPrompt  // LLM produced a detailed prompt — keep it
        : generateAgentSystemPrompt(resolvedName, resolvedDescription, resolvedArchetype)

      return {
        data: {
          name: resolvedName,
          description: resolvedDescription,
          archetype: resolvedArchetype,
          systemPrompt: resolvedSystemPrompt,
          autonomyLevel: parsed.autonomyLevel || 'SUPERVISED',
          suggestedTools: parsed.suggestedTools || [],
        }
      }
    } catch (err) {
      if (err.message === 'LLM_RATE_LIMITED') {
        return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'LLM rate limit reached. Please try again in a moment.' } })
      }
      if (err.message === 'LLM_AUTH_ERROR') {
        return reply.status(400).send({ error: { code: 'LLM_NOT_CONFIGURED', message: 'No LLM configured for this tenant. Set up an API key in Settings.' } })
      }
      return errorResponse(reply, err)
    }
  })

  // POST /tenants/:tenantId/agents/generate-skill — AI-powered skill creation
  // Body: { prompt: string, skillType: 'nl'|'api'|'code', language?: 'javascript'|'python' }
  // Returns: { name, description, type, instruction?, code?, url?, method?, headers?, bodyTemplate?, language? }
  fastify.post('/tenants/:tenantId/agents/generate-skill', {
    preHandler: [fastify.authenticate, requirePermission('agent:create')]
  }, async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { prompt, skillType, language } = req.body || {}

      if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
        return reply.status(400).send({ error: { code: 'INVALID_PROMPT', message: 'Prompt must be at least 10 characters.' } })
      }

      const type = skillType || 'nl'

      const systemPrompt = `You are a skill designer for the Kuvalam AI agent platform. Given a user's description of what they want a skill to do, generate a JSON object with the appropriate fields based on the skill type.

Skill type requested: ${type}${type === 'code' ? ` (language: ${language || 'javascript'})` : ''}

For ALL types, include:
- "name": snake_case skill name (max 40 chars, e.g. "send_email", "lookup_order")
- "description": One-line summary of what the skill does and when to use it (max 100 chars)

For "nl" (Natural Language) skills, also include:
- "instruction": Detailed plain-English steps the agent should follow. Be specific about what tools to use, data flow, and output format. (200-600 chars)

For "api" skills, also include:
- "url": The API endpoint URL. Use {{input.param}} for dynamic args and {{config.secret}} for secrets.
- "method": HTTP method (GET, POST, PUT, DELETE)
- "headers": JSON object of headers (as a stringified JSON object)
- "bodyTemplate": For POST/PUT/PATCH, JSON body template with {{input.param}} placeholders (as stringified JSON). Omit for GET/DELETE.

For "code" skills, also include:
- "code": The full code.${language === 'python' ? ' Python code with a def run(input): function that returns a dict. Use only stdlib unless essential.' : ' JavaScript code using the input object. fetch() is available globally. Return a value or object.'}

Rules:
- Return ONLY valid JSON — no markdown, no backticks, no explanation.
- Make practical, useful skills that an AI agent would actually call.
- For NL skills, mention concrete tool names (from the list: list_tables, describe_table, query, run_query, read_file, write_file, list_files, search_files, browse_url, browser_use, web_search, calculator, clock, email_send, slack_send_message, publish_dashboard_report, http_request, http_download, file_search, docker_run, ssh_exec, delegate_task, a2a_call).
- For API skills, use realistic endpoint patterns.
- For code skills, write clean, error-handled code that validates input.`

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Create a ${type === 'nl' ? 'natural language' : type === 'api' ? 'API/webhook' : 'code'} skill that: ${prompt.trim()}` },
      ]

      // Get tenant LLM config
      const { query: dbQuery } = await import('../db/pool.js')
      const { rows } = await dbQuery(
        'SELECT llm_config FROM tenants WHERE id = $1',
        [tenantId]
      )
      const llmConfig = rows?.[0]?.llm_config || {}

      const { complete } = await import('../services/llm.service.js')

      const result = await complete({
        tenantId,
        agentId: 'skill-generator',
        messages,
        llmConfig,
        useSystemLlm: true,
        temperature: 0.2,
        goal: `Generate skill from prompt: ${prompt.trim().slice(0, 80)}`,
      })

      // Parse the LLM response as JSON
      const text = (result.content || '').trim()
      let parsed
      try {
        const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        parsed = JSON.parse(clean)
      } catch {
        return reply.status(422).send({
          error: { code: 'PARSE_ERROR', message: 'Failed to parse generated skill. Please try rephrasing your prompt.', raw: text.slice(0, 500) }
        })
      }

      return {
        data: {
          name: parsed.name || 'custom_skill',
          description: parsed.description || `AI-generated skill: ${prompt.trim().slice(0, 60)}…`,
          type,
          instruction: parsed.instruction || undefined,
          code: parsed.code || undefined,
          language: language || parsed.language || undefined,
          url: parsed.url || undefined,
          method: parsed.method || undefined,
          headers: parsed.headers || undefined,
          bodyTemplate: parsed.bodyTemplate || undefined,
        }
      }
    } catch (err) {
      if (err.message === 'LLM_RATE_LIMITED') {
        return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'LLM rate limit reached. Please try again in a moment.' } })
      }
      if (err.message === 'LLM_AUTH_ERROR') {
        return reply.status(400).send({ error: { code: 'LLM_NOT_CONFIGURED', message: 'No LLM configured for this tenant. Set up an API key in Settings.' } })
      }
      return errorResponse(reply, err)
    }
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

  // DELETE /tenants/:tenantId/agents/:agentId
  fastify.delete('/tenants/:tenantId/agents/:agentId', auth, async (req, reply) => {
    try {
      await agentService.deleteAgent(req.params.tenantId, req.params.agentId, req.user.sub)
      return reply.send({ success: true, meta: ts() })
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

  // POST /tenants/:tenantId/agents/:agentId/test-skill
  fastify.post('/tenants/:tenantId/agents/:agentId/test-skill', {
    schema: { params: agentIdParam },
    preHandler: [fastify.authenticate, requirePermission('skill:test')]
  }, async (req, reply) => {
    try {
      const { code, input, env } = req.body
      const result = await executeCustomSkill(code, input || {}, env || {})
      return reply.send({ success: true, data: result, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/agents/:agentId/preview-prompt
  // Returns the full system prompt that would be used when this agent executes a task.
  fastify.get('/tenants/:tenantId/agents/:agentId/preview-prompt', {
    schema: { params: agentIdParam },
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    try {
      const { agentId, tenantId } = req.params
      const agent = await agentService.getAgent(tenantId, agentId)
      if (!agent) throw new AppError('AGENT_NOT_FOUND', 'Agent not found', 404)

      const { generateAgentSystemPrompt } = await import('../services/agent.service.js')
      const archetypePrompt = generateAgentSystemPrompt(
        agent.name,
        agent.description || '',
        agent.archetype || 'coordinator'
      )

      // Build the complete prompt: user's system_prompt (instructions) + archetype template
      const userInstructions = (agent.system_prompt || '').trim()
      const fullPrompt = userInstructions
        ? `${userInstructions}\n\n---\n\n${archetypePrompt}`
        : archetypePrompt

      return reply.send({
        success: true,
        data: {
          agentId,
          agentName: agent.name,
          archetype: agent.archetype,
          systemPrompt: fullPrompt,
          hasCustomInstructions: !!userInstructions,
          charCount: fullPrompt.length,
          estimatedTokens: Math.ceil(fullPrompt.length / 4) // rough estimate
        },
        meta: ts()
      })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/agents/:agentId/knowledge-bases/:kbId
  fastify.post('/tenants/:tenantId/agents/:agentId/knowledge-bases/:kbId', auth, async (req, reply) => {
    try {
      await agentService.linkKnowledgeBase(req.params.tenantId, req.params.agentId, req.params.kbId, req.user.sub)
      return reply.send({ success: true, data: { linked: true }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // DELETE /tenants/:tenantId/agents/:agentId/knowledge-bases/:kbId
  fastify.delete('/tenants/:tenantId/agents/:agentId/knowledge-bases/:kbId', auth, async (req, reply) => {
    try {
      await agentService.unlinkKnowledgeBase(req.params.tenantId, req.params.agentId, req.params.kbId, req.user.sub)
      return reply.send({ success: true, data: { unlinked: true }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/agents/:agentId/tasks — dispatch a task
  fastify.post('/tenants/:tenantId/agents/:agentId/tasks', {
    schema: { params: agentIdParam, ...dispatchTaskSchema },
    preHandler: [fastify.authenticate, requirePermission('agent:execute')]
  }, async (req, reply) => {
    try {
      await checkTenantTaskRateLimit(req.params.tenantId)
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

  // POST /tenants/:tenantId/agents/:agentId/tasks/:taskId/cancel
  fastify.post('/tenants/:tenantId/agents/:agentId/tasks/:taskId/cancel', auth, async (req, reply) => {
    try {
      await taskService.cancelTask(req.params.tenantId, req.params.agentId, req.params.taskId, req.user.sub)
      return reply.send({ success: true, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // DELETE /tenants/:tenantId/agents/:agentId/skills/:skillId
  fastify.delete('/tenants/:tenantId/agents/:agentId/skills/:skillId', auth, async (req, reply) => {
    try {
      await agentService.removeSkill(req.params.tenantId, req.params.agentId, req.params.skillId, req.user.sub)
      return reply.send({ success: true, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // DELETE /tenants/:tenantId/agents/:agentId/rules/:ruleId
  fastify.delete('/tenants/:tenantId/agents/:agentId/rules/:ruleId', auth, async (req, reply) => {
    try {
      await agentService.removeRule(req.params.tenantId, req.params.agentId, req.params.ruleId, req.user.sub)
      return reply.send({ success: true, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // DELETE /tenants/:tenantId/agents/:agentId/tasks/:taskId
  fastify.delete('/tenants/:tenantId/agents/:agentId/tasks/:taskId', auth, async (req, reply) => {
    try {
      await agentService.deleteTask(req.params.tenantId, req.params.agentId, req.params.taskId, req.user.sub)
      return reply.send({ success: true, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // ═════════════════════════════════════════════════════════════════════════════
  // Agent Tool Scopes — define which connectors/MCPs/built-ins an agent can use
  // ═════════════════════════════════════════════════════════════════════════════

  // GET  /tenants/:tenantId/agents/:agentId/scopes              — list scopes
  // POST /tenants/:tenantId/agents/:agentId/scopes              — add scope
  // PATCH /tenants/:tenantId/agents/:agentId/scopes/:scopeId    — update scope level
  // DELETE /tenants/:tenantId/agents/:agentId/scopes/:scopeId   — remove scope
  // PUT  /tenants/:tenantId/agents/:agentId/scopes              — bulk replace all scopes
  // GET  /tenants/:tenantId/agents/:agentId/scopes/presets      — archetype preset suggestions

  fastify.get('/tenants/:tenantId/agents/:agentId/scopes', auth, async (req, reply) => {
    try {
      const scopes = await scopeService.listScopes(req.params.tenantId, req.params.agentId)
      return reply.send({ success: true, data: { scopes }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  fastify.post('/tenants/:tenantId/agents/:agentId/scopes', {
    ...auth,
    preHandler: [fastify.authenticate, requirePermission('agent:scopes')]
  }, async (req, reply) => {
    try {
      const scope = await scopeService.addScope(req.params.tenantId, req.params.agentId, req.body)
      return reply.status(201).send({ success: true, data: scope, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  fastify.patch('/tenants/:tenantId/agents/:agentId/scopes/:scopeId', {
    ...auth,
    preHandler: [fastify.authenticate, requirePermission('agent:scopes')]
  }, async (req, reply) => {
    try {
      const scope = await scopeService.updateScope(req.params.tenantId, req.params.agentId, req.params.scopeId, req.body)
      return reply.send({ success: true, data: scope, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  fastify.delete('/tenants/:tenantId/agents/:agentId/scopes/:scopeId', {
    ...auth,
    preHandler: [fastify.authenticate, requirePermission('agent:scopes')]
  }, async (req, reply) => {
    try {
      await scopeService.removeScope(req.params.tenantId, req.params.agentId, req.params.scopeId)
      return reply.send({ success: true, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // Bulk replace all scopes (send array of scope objects)
  fastify.put('/tenants/:tenantId/agents/:agentId/scopes', {
    ...auth,
    preHandler: [fastify.authenticate, requirePermission('agent:scopes')]
  }, async (req, reply) => {
    try {
      const scopes = await scopeService.setScopes(req.params.tenantId, req.params.agentId, req.body.scopes || [])
      return reply.send({ success: true, data: { scopes }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // Get archetype-based scope presets — returns ALL archetypes so the UI can
  // let the user pick presets for any archetype regardless of the agent's own.
  fastify.get('/tenants/:tenantId/agents/:agentId/scopes/presets', auth, async (req, reply) => {
    try {
      const allArchetypes = ['customer-support', 'data-analyst', 'developer', 'browser-automation', 'analyst']
      const presets = {}
      for (const a of allArchetypes) {
        const p = scopeService.getArchetypeScopePresets(a)
        if (p) presets[a] = p
      }
      return reply.send({ success: true, data: { presets }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })
}

const ts = () => ({ timestamp: new Date().toISOString() })
