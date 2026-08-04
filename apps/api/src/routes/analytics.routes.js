// apps/api/src/routes/analytics.routes.js
import { query } from '../db/pool.js'
import { get, set } from '../services/cache.service.js'

// Load pricing from DB; falls back to inline defaults for bootstrapping.
// Pricing is cached for 10 minutes — stale pricing is acceptable for cost estimates.
let _pricingCache = null
let _pricingCacheAt = 0
const PRICING_CACHE_TTL_MS = 10 * 60 * 1000

async function getPricingConfig() {
  if (_pricingCache && (Date.now() - _pricingCacheAt) < PRICING_CACHE_TTL_MS) {
    return _pricingCache
  }
  try {
    const { rows } = await query(
      `SELECT model_id, input_cost_per_million, output_cost_per_million
       FROM llm_pricing_config
       WHERE is_active = true AND (tenant_id IS NULL)
       ORDER BY model_id`
    )
    const map = {}
    for (const r of rows) {
      map[r.model_id] = { input: parseFloat(r.input_cost_per_million), output: parseFloat(r.output_cost_per_million) }
    }
    // Default fallback if no pricing rows exist
    if (Object.keys(map).length === 0) {
      map['default'] = { input: 2.50, output: 10.00 }
    }
    _pricingCache = map
    _pricingCacheAt = Date.now()
    return map
  } catch {
    // DB may not have the table yet — use hardcoded fallback
    return { default: { input: 2.50, output: 10.00 } }
  }
}

async function estimateCost(model, promptTokens, completionTokens) {
  const pricing = await getPricingConfig()
  // Exact match first, then substring match, then default
  let rates = pricing[model]
  if (!rates) {
    const key = Object.keys(pricing).find(k => k !== 'default' && model?.includes(k))
    rates = key ? pricing[key] : (pricing['default'] || { input: 2.50, output: 10.00 })
  }
  return ((promptTokens / 1_000_000) * rates.input) + ((completionTokens / 1_000_000) * rates.output)
}

export default async function analyticsRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate)

  // Get tenant analytics overview (cached 60s — analytics data is not real-time critical)
  fastify.get('/tenants/:tenantId/analytics', async (req, reply) => {
    const { tenantId } = req.params

    // ── Security: ensure the authenticated user belongs to the requested tenant ──
    // req.user.tenantId is set by the JWT authentication middleware from the
    // token's 'tenantId' claim. Without this check any authenticated user could
    // read another tenant's agent counts, LLM costs, and audit activity.
    if (req.user.tenantId !== tenantId) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Access denied to this organization\'s analytics' } })
    }

    const cacheKey = `analytics:${tenantId}`

    // Try Redis cache first
    const cachedResult = await get(cacheKey)
    if (cachedResult !== null && typeof cachedResult === 'object' && cachedResult.data) {
      return cachedResult
    }

    // Cache miss — fetch fresh data
    const data = await fetchAnalyticsData(tenantId)
    const payload = { data }
    // Cache for 60s (fire-and-forget — failure is non-critical)
    set(cacheKey, payload, 60).catch(() => {})
    return payload
  })
}


async function fetchAnalyticsData(tenantId) {
    const [
      agentStats,
      taskStats,
      workflowStats,
      knowledgeStats,
      approvalStats,
      recentActivity,
      tasksByDay,
      topAgents,
      tokenUsage,
      tenantConfig,
      customModels,
      modelPerf,
      latestExecutions
    ] = await Promise.all([
      // Agent counts
      query(
        `SELECT status, COUNT(*) as count FROM agents WHERE tenant_id = $1 AND status != 'ARCHIVED' GROUP BY status`,
        [tenantId]
      ),

      // Task stats
      query(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed,
           COUNT(*) FILTER (WHERE status = 'FAILED') as failed,
           COUNT(*) FILTER (WHERE status = 'RUNNING') as running,
           ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::numeric, 0) as avg_duration_ms
         FROM agent_tasks
         WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '30 days'`,
        [tenantId]
      ),

      // Workflow execution stats
      query(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed,
           COUNT(*) FILTER (WHERE status = 'FAILED') as failed,
           COUNT(*) FILTER (WHERE status = 'PENDING_APPROVAL') as pending_approval
         FROM workflow_executions
         WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '30 days'`,
        [tenantId]
      ),

      // Knowledge stats
      query(
        `SELECT
           COUNT(DISTINCT kb.id) as knowledge_bases,
           COUNT(kd.id) as documents
         FROM knowledge_bases kb
         LEFT JOIN knowledge_documents kd ON kd.knowledge_base_id = kb.id
         WHERE kb.tenant_id = $1`,
        [tenantId]
      ),

      // Approval stats
      query(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE status = 'PENDING') as pending,
           COUNT(*) FILTER (WHERE status = 'APPROVED') as approved,
           COUNT(*) FILTER (WHERE status = 'REJECTED') as rejected
         FROM approval_requests
         WHERE tenant_id = $1`,
        [tenantId]
      ),

      // Recent audit activity (last 30 business events, filtered)
      query(
        `SELECT
           a.event_type, a.actor_type, a.actor_id, a.resource_type, a.resource_id,
           a.action, a.created_at, a.metadata,
           COALESCE(ag.name, u.email, 'System') as actor_name,
           COALESCE(t.goal, wf.name, '') as resource_label,
           wf_name.name as workflow_name
         FROM audit_log a
         LEFT JOIN agents ag ON a.actor_type = 'AGENT' AND ag.id::text = a.actor_id
         LEFT JOIN users u ON a.actor_type = 'USER' AND u.id::text = a.actor_id
         LEFT JOIN agent_tasks t ON a.resource_type = 'AgentTask' AND t.id = a.resource_id
         LEFT JOIN workflows wf ON a.resource_type = 'Workflow' AND wf.id = a.resource_id
         LEFT JOIN workflows wf_name ON wf_name.id::text = COALESCE(
           CASE WHEN a.event_type = 'trigger.fired' THEN a.resource_id::text ELSE NULL END,
           a.metadata->>'workflowId'
         )
         WHERE a.tenant_id = $1
           AND a.event_type NOT IN ('llm.tokens_used', 'agent.tool_executed')
         ORDER BY a.created_at DESC LIMIT 30`,
        [tenantId]
      ),

      // Tasks dispatched per day (last 14 days)
      query(
        `SELECT
           DATE(created_at) as day,
           COUNT(*) as tasks,
           COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed
         FROM agent_tasks
         WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '14 days'
         GROUP BY DATE(created_at)
         ORDER BY day ASC`,
        [tenantId]
      ),

      // Top performing agents by task count
      query(
        `SELECT
           a.id, a.name, a.archetype,
           COUNT(t.id) as task_count,
           COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED') as completed,
           COUNT(t.id) FILTER (WHERE t.status = 'FAILED') as failed
         FROM agents a
         LEFT JOIN agent_tasks t ON t.agent_id = a.id AND t.created_at > NOW() - INTERVAL '30 days'
         WHERE a.tenant_id = $1
         GROUP BY a.id, a.name, a.archetype
         ORDER BY task_count DESC
         LIMIT 5`,
        [tenantId]
      ),

      // Token usage aggregated by model (last 30 days)
      query(
        `SELECT
           metadata->>'model' as model,
           SUM((metadata->>'promptTokens')::bigint) as prompt_tokens,
           SUM((metadata->>'completionTokens')::bigint) as completion_tokens,
           SUM((metadata->>'totalTokens')::bigint) as total_tokens
         FROM audit_log
         WHERE tenant_id = $1
           AND event_type = 'llm.tokens_used'
           AND created_at > NOW() - INTERVAL '30 days'
         GROUP BY metadata->>'model'`,
        [tenantId]
      ),

      // Tenant LLM config — all configured providers/models
      query(
        `SELECT llm_config FROM tenants WHERE id = $1`,
        [tenantId]
      ),

      // Custom (fine-tuned) models for this tenant
      query(
        `SELECT model_name, base_model_path, status FROM custom_models WHERE tenant_id = $1`,
        [tenantId]
      ),

      // Model performance — per agent+model task metrics (last 30 days)
      query(
        `SELECT
           a.id AS agent_id, a.name AS agent_name, a.archetype,
           a.llm_model AS model, a.llm_provider AS provider,
           COUNT(t.id) AS task_count,
           COUNT(t.id) FILTER (WHERE t.status = 'COMPLETED') AS completed,
           COUNT(t.id) FILTER (WHERE t.status = 'FAILED') AS failed,
           ROUND(AVG(EXTRACT(EPOCH FROM (t.completed_at - t.started_at)) * 1000)::numeric, 0) AS avg_duration_ms,
           ROUND(AVG((t.result->>'hallucinationScore')::numeric)::numeric, 0) AS avg_hallucination_score,
           ROUND(AVG((t.result->>'outputQuality')::numeric)::numeric, 0) AS avg_output_quality,
           ROUND(AVG((t.result->>'scopeAdherence')::numeric)::numeric, 0) AS avg_scope_adherence,
           ROUND(AVG((t.result->>'toolAccuracy')::numeric)::numeric, 0) AS avg_tool_accuracy,
           ROUND(AVG((t.result->>'contextUsage')::numeric)::numeric, 0) AS avg_context_usage,
           ROUND(AVG((t.result->>'toolRelevance')::numeric)::numeric, 0) AS avg_tool_relevance,
           ROUND(AVG((t.result->>'humanLikeness')::numeric)::numeric, 0) AS avg_human_likeness,
           ROUND(AVG((t.token_usage->>'total')::numeric)::numeric, 0) AS avg_tokens,
           ROUND(AVG(jsonb_array_length(COALESCE(t.actions, '[]')))::numeric, 1) AS avg_actions
         FROM agents a
         LEFT JOIN agent_tasks t ON t.agent_id = a.id AND t.created_at > NOW() - INTERVAL '30 days'
         WHERE a.tenant_id = $1 AND a.status != 'ARCHIVED'
         GROUP BY a.id, a.name, a.archetype, a.llm_model, a.llm_provider
         ORDER BY COUNT(t.id) DESC`,
        [tenantId]
      ),

      // ── Latest execution per agent+model (for per-agent drill-down) ──
      // When the user selects an agent, show the MOST RECENT task per model,
      // not a blended average. DISTINCT ON keeps only the latest row per group.
      // Uses the agent's current llm_model (tasks don't track per-execution model).
      query(
        `SELECT DISTINCT ON (a.id, a.llm_model)
           a.id AS agent_id,
           a.llm_model AS model,
           a.llm_provider AS provider,
           t.id AS task_id,
           t.status,
           EXTRACT(EPOCH FROM (t.completed_at - t.started_at)) * 1000 AS duration_ms,
           (t.result->>'hallucinationScore')::numeric AS hallucination_score,
           (t.result->>'outputQuality')::numeric AS output_quality,
           (t.result->>'scopeAdherence')::numeric AS scope_adherence,
           (t.result->>'toolAccuracy')::numeric AS tool_accuracy,
           (t.result->>'contextUsage')::numeric AS context_usage,
           (t.result->>'toolRelevance')::numeric AS tool_relevance,
           (t.result->>'humanLikeness')::numeric AS human_likeness,
           (t.token_usage->>'total')::numeric AS tokens,
           jsonb_array_length(COALESCE(t.actions, '[]')) AS actions_count,
           t.created_at
         FROM agents a
         JOIN agent_tasks t ON t.agent_id = a.id
         WHERE a.tenant_id = $1
           AND a.status != 'ARCHIVED'
           AND a.llm_model IS NOT NULL
           AND t.created_at > NOW() - INTERVAL '30 days'
           AND t.status = 'COMPLETED'
         ORDER BY a.id, a.llm_model, t.created_at DESC`,
        [tenantId]
      )
    ])

    // Process agent status map
    const agentMap = {}
    for (const row of agentStats.rows) agentMap[row.status] = parseInt(row.count)

    const tasks = taskStats.rows[0]
    const workflows = workflowStats.rows[0]
    const knowledge = knowledgeStats.rows[0]
    const approvals = approvalStats.rows[0]

    // Calculate token cost estimates per model and total
    const pricing = await getPricingConfig()

    // Build a map of model → token usage from audit data
    const usageByModel = {}
    for (const row of tokenUsage.rows) {
      const model = row.model || 'unknown'
      usageByModel[model] = {
        promptTokens: parseInt(row.prompt_tokens) || 0,
        completionTokens: parseInt(row.completion_tokens) || 0,
        totalTokens: parseInt(row.total_tokens) || 0
      }
    }

    // Collect all configured model names from tenant LLM config + custom models
    const configuredModels = new Set()
    try {
      const llmConfig = tenantConfig.rows[0]?.llm_config
      if (llmConfig?.providers) {
        for (const provider of Object.values(llmConfig.providers)) {
          if (provider.model) configuredModels.add(provider.model)
        }
      }
    } catch { /* ignore malformed config */ }
    for (const cm of customModels.rows) {
      configuredModels.add(cm.model_name)
      if (cm.base_model_path) configuredModels.add(cm.base_model_path)
    }

    // Merge: start with models that have usage, then add configured models with zero usage
    const seenModels = new Set()
    const tokenBreakdown = []

    // First, add all models with usage data
    for (const row of tokenUsage.rows) {
      const model = row.model || 'unknown'
      seenModels.add(model)
      const promptTokens = usageByModel[model].promptTokens
      const completionTokens = usageByModel[model].completionTokens
      let rates = pricing[model]
      if (!rates) {
        const key = Object.keys(pricing).find(k => k !== 'default' && model?.includes(k))
        rates = key ? pricing[key] : (pricing['default'] || { input: 2.50, output: 10.00 })
      }
      const costUsd = ((promptTokens / 1_000_000) * rates.input) + ((completionTokens / 1_000_000) * rates.output)
      tokenBreakdown.push({
        model,
        promptTokens,
        completionTokens,
        totalTokens: usageByModel[model].totalTokens,
        estimatedCostUsd: Math.round(costUsd * 10000) / 10000
      })
    }

    // Then, add configured models with zero usage (so they appear in the table)
    for (const model of configuredModels) {
      if (!seenModels.has(model)) {
        seenModels.add(model)
        let rates = pricing[model]
        if (!rates) {
          const key = Object.keys(pricing).find(k => k !== 'default' && model?.includes(k))
          rates = key ? pricing[key] : (pricing['default'] || { input: 2.50, output: 10.00 })
        }
        tokenBreakdown.push({
          model,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0
        })
      }
    }

    const totalCostUsd = tokenBreakdown.reduce((sum, r) => sum + r.estimatedCostUsd, 0)
    const totalTokensUsed = tokenBreakdown.reduce((sum, r) => sum + r.totalTokens, 0)

    return {
      agents: {
          total: Object.values(agentMap).reduce((a, b) => a + b, 0),
          active: agentMap['ACTIVE'] || 0,
          draft: agentMap['DRAFT'] || 0,
        },
        tasks: {
          total: parseInt(tasks.total) || 0,
          completed: parseInt(tasks.completed) || 0,
          failed: parseInt(tasks.failed) || 0,
          running: parseInt(tasks.running) || 0,
          successRate: tasks.total > 0 ? Math.round((tasks.completed / tasks.total) * 100) : 0,
          avgDurationMs: parseInt(tasks.avg_duration_ms) || 0,
        },
        workflows: {
          total: parseInt(workflows.total) || 0,
          completed: parseInt(workflows.completed) || 0,
          failed: parseInt(workflows.failed) || 0,
          pendingApproval: parseInt(workflows.pending_approval) || 0,
        },
        knowledge: {
          knowledgeBases: parseInt(knowledge.knowledge_bases) || 0,
          documents: parseInt(knowledge.documents) || 0,
        },
        approvals: {
          total: parseInt(approvals.total) || 0,
          pending: parseInt(approvals.pending) || 0,
          approved: parseInt(approvals.approved) || 0,
          rejected: parseInt(approvals.rejected) || 0,
        },
        recentActivity: recentActivity.rows.map(r => {
          // Build human-readable summary in JS (avoids PostgreSQL CASE type inference issues)
          const meta = r.metadata || {}
          let summary = ''
          if (r.event_type.startsWith('agent.task_')) {
            summary = meta.goal || r.resource_label || `Task ${String(r.resource_id || '').slice(0, 8)}`
          } else if (r.event_type.startsWith('workflow.step_')) {
            summary = `Step: ${meta.stepId || '?'} (${meta.stepType || '?'})`
          } else if (r.event_type.startsWith('workflow.execution_') || r.event_type === 'trigger.fired') {
            summary = r.workflow_name || r.resource_label || `Workflow ${String(meta.workflowId || r.resource_id || '').slice(0, 8)}`
          } else if (r.event_type.startsWith('agent.')) {
            summary = r.actor_name || `Agent ${String(r.actor_id || '').slice(0, 8)}`
          } else if (r.event_type.startsWith('workflow.')) {
            summary = r.resource_label || `Workflow ${String(r.resource_id || '').slice(0, 8)}`
          } else if (r.event_type.startsWith('connector.')) {
            summary = `${r.resource_type} ${String(r.resource_id || '').slice(0, 8)}`
          } else {
            summary = `${r.resource_type} ${String(r.resource_id || '').slice(0, 8)}`
          }
          return {
            eventType: r.event_type,
            action: r.action,
            actor: { type: r.actor_type, name: r.actor_name, id: r.actor_id },
            resource: { type: r.resource_type, name: r.resource_label, id: r.resource_id },
            summary,
            metadata: meta,
            durationMs: parseInt(meta.durationMs) || null,
            actionsCount: parseInt(meta.actionsCount) || null,
            stepCount: parseInt(meta.stepCount) || null,
            workflowName: r.workflow_name,
            timestamp: r.created_at
          }
        }),
        tasksByDay: tasksByDay.rows,
        topAgents: topAgents.rows.map(a => ({
          ...a,
          task_count: parseInt(a.task_count),
          completed: parseInt(a.completed),
          failed: parseInt(a.failed),
          successRate: a.task_count > 0 ? Math.round((a.completed / a.task_count) * 100) : 0
        })),
        modelPerformance: buildModelPerformance(modelPerf.rows, latestExecutions.rows),
        llmCost: {
          totalTokens: totalTokensUsed,
          estimatedCostUsd: Math.round(totalCostUsd * 10000) / 10000,
          byModel: tokenBreakdown
        }
    }
}

// Build model-performance analytics from per-agent+model task rows.
// Returns both a per-agent breakdown and a per-model aggregate so the UI can
// compare "which LLM is the best fit" across speed, success, hallucination,
// output quality, and cost.
function buildModelPerformance(rows, latestRows) {
  // ── Latest-execution lookup: agentId::model → latest task scores ──
  const latestByAgentModel = {}
  for (const r of (latestRows || [])) {
    const key = `${r.agent_id}::${r.model || 'unknown'}`
    latestByAgentModel[key] = {
      taskId: r.task_id,
      status: r.status,
      durationMs: Math.round(parseFloat(r.duration_ms) || 0),
      hallucinationScore: Math.round(parseFloat(r.hallucination_score) || 60),
      outputQuality: Math.round(parseFloat(r.output_quality) || 80),
      scopeAdherence: Math.round(parseFloat(r.scope_adherence) || 100),
      toolAccuracy: r.tool_accuracy != null ? Math.round(parseFloat(r.tool_accuracy)) : null,
      contextUsage: r.context_usage != null ? Math.round(parseFloat(r.context_usage)) : null,
      toolRelevance: r.tool_relevance != null ? Math.round(parseFloat(r.tool_relevance)) : null,
      humanLikeness: r.human_likeness != null ? Math.round(parseFloat(r.human_likeness)) : null,
      tokens: parseInt(r.tokens) || 0,
      actionsCount: parseInt(r.actions_count) || 0,
      createdAt: r.created_at,
    }
  }

  const byAgent = rows.map(r => {
    const taskCount = parseInt(r.task_count) || 0
    const completed = parseInt(r.completed) || 0
    const failed = parseInt(r.failed) || 0
    const successRate = taskCount > 0 ? Math.round((completed / taskCount) * 100) : 0
    const avgDurationMs = parseInt(r.avg_duration_ms) || 0
    const hallucinationScore = parseInt(r.avg_hallucination_score) || 60
    const hallucinationRate = Math.max(0, Math.min(100, 100 - hallucinationScore))
    const outputQuality = parseInt(r.avg_output_quality) || 80
    const scopeAdherence = parseInt(r.avg_scope_adherence) || 100
    const toolAccuracy = r.avg_tool_accuracy != null ? parseInt(r.avg_tool_accuracy) : null
    const contextUsage = r.avg_context_usage != null ? parseInt(r.avg_context_usage) : null
    const toolRelevance = r.avg_tool_relevance != null ? parseInt(r.avg_tool_relevance) : null
    const humanLikeness = r.avg_human_likeness != null ? parseInt(r.avg_human_likeness) : null
    return {
      agentId: r.agent_id,
      agentName: r.agent_name,
      archetype: r.archetype,
      model: r.model || 'unknown',
      provider: r.provider || 'unknown',
      taskCount,
      completed,
      failed,
      successRate,
      avgDurationMs,
      hallucinationScore,
      hallucinationRate,
      outputQuality,
      scopeAdherence,
      toolAccuracy,
      contextUsage,
      toolRelevance,
      humanLikeness,
      avgTokens: parseInt(r.avg_tokens) || 0,
      avgActions: parseFloat(r.avg_actions) || 0
    }
  })

  // ── Volume metrics: aggregate per model from ALL historical tasks ──
  const volumeMap = {}
  for (const a of byAgent) {
    const key = a.model
    if (!volumeMap[key]) {
      volumeMap[key] = {
        model: a.model, provider: a.provider,
        agents: 0, taskCount: 0, completed: 0, failed: 0,
        totalDurationMs: 0, totalTokens: 0, totalActions: 0,
      }
    }
    const m = volumeMap[key]
    m.agents += 1
    m.taskCount += a.taskCount
    m.completed += a.completed
    m.failed += a.failed
    m.totalDurationMs += a.avgDurationMs * a.taskCount
    m.totalTokens += a.avgTokens * a.taskCount
    m.totalActions += a.avgActions * a.taskCount
  }

  // ── Quality metrics: aggregate per model from LATEST execution only ──
  // Each (agent, model) contributes its most recent task's scores exactly once.
  // This prevents score convergence where averaging hundreds of tasks with
  // similar baselines makes every model look identical.
  const qualityMap = {}
  for (const [key, entry] of Object.entries(latestByAgentModel)) {
    // key is "agentId::model"
    const model = key.split('::').slice(1).join('::') || 'unknown'
    if (!qualityMap[model]) {
      qualityMap[model] = {
        agentCount: 0,
        sumHallucination: 0, sumOutputQuality: 0, sumScopeAdherence: 0,
        sumToolAccuracy: 0, toolAccuracyCount: 0,
        sumContextUsage: 0, contextUsageCount: 0,
        sumToolRelevance: 0, toolRelevanceCount: 0,
        sumHumanLikeness: 0, humanLikenessCount: 0,
      }
    }
    const q = qualityMap[model]
    q.agentCount += 1
    q.sumHallucination += entry.hallucinationScore
    q.sumOutputQuality += entry.outputQuality
    q.sumScopeAdherence += entry.scopeAdherence
    if (entry.toolAccuracy != null) {
      q.sumToolAccuracy += entry.toolAccuracy
      q.toolAccuracyCount += 1
    }
    if (entry.contextUsage != null) {
      q.sumContextUsage += entry.contextUsage
      q.contextUsageCount += 1
    }
    if (entry.toolRelevance != null) {
      q.sumToolRelevance += entry.toolRelevance
      q.toolRelevanceCount += 1
    }
    if (entry.humanLikeness != null) {
      q.sumHumanLikeness += entry.humanLikeness
      q.humanLikenessCount += 1
    }
  }

  // ── Merge volume + latest quality into byModel ──
  const allModels = new Set([...Object.keys(volumeMap), ...Object.keys(qualityMap)])
  const byModel = [...allModels].map(model => {
    const vol = volumeMap[model] || { model, provider: 'unknown', agents: 0, taskCount: 0, completed: 0, failed: 0, totalDurationMs: 0, totalTokens: 0, totalActions: 0 }
    const q = qualityMap[model]

    const successRate = vol.taskCount > 0 ? Math.round((vol.completed / vol.taskCount) * 100) : 0
    const avgDurationMs = vol.taskCount > 0 ? Math.round(vol.totalDurationMs / vol.taskCount) : 0
    const avgTokens = vol.taskCount > 0 ? Math.round(vol.totalTokens / vol.taskCount) : 0
    const avgActions = vol.taskCount > 0 ? Math.round((vol.totalActions / vol.taskCount) * 10) / 10 : 0

    // Use latest quality scores when available; fall back to aggregate defaults only when no latest data exists
    let hallucinationScore, outputQuality, scopeAdherence, toolAccuracy, contextUsage, toolRelevance, humanLikeness

    if (q && q.agentCount > 0) {
      hallucinationScore = Math.round(q.sumHallucination / q.agentCount)
      outputQuality = Math.round(q.sumOutputQuality / q.agentCount)
      scopeAdherence = Math.round(q.sumScopeAdherence / q.agentCount)
      toolAccuracy = q.toolAccuracyCount > 0 ? Math.round(q.sumToolAccuracy / q.toolAccuracyCount) : null
      contextUsage = q.contextUsageCount > 0 ? Math.round(q.sumContextUsage / q.contextUsageCount) : null
      toolRelevance = q.toolRelevanceCount > 0 ? Math.round(q.sumToolRelevance / q.toolRelevanceCount) : null
      humanLikeness = q.humanLikenessCount > 0 ? Math.round(q.sumHumanLikeness / q.humanLikenessCount) : null
    } else {
      // No latest execution data for this model — use historical aggregate
      // as a fallback so the chart isn't empty
      const hist = volumeMap[model]
      const t = hist?.taskCount || 0
      // Recompute from byAgent for this model
      const agentsForModel = byAgent.filter(a => a.model === model)
      const tot = agentsForModel.length
      hallucinationScore = tot > 0 ? Math.round(agentsForModel.reduce((s, a) => s + a.hallucinationScore * a.taskCount, 0) / Math.max(1, agentsForModel.reduce((s, a) => s + a.taskCount, 0))) : 60
      outputQuality = tot > 0 ? Math.round(agentsForModel.reduce((s, a) => s + a.outputQuality * a.taskCount, 0) / Math.max(1, agentsForModel.reduce((s, a) => s + a.taskCount, 0))) : 80
      scopeAdherence = tot > 0 ? Math.round(agentsForModel.reduce((s, a) => s + a.scopeAdherence * a.taskCount, 0) / Math.max(1, agentsForModel.reduce((s, a) => s + a.taskCount, 0))) : 100
      const taEntries = agentsForModel.filter(a => a.toolAccuracy != null)
      toolAccuracy = taEntries.length > 0 ? Math.round(taEntries.reduce((s, a) => s + a.toolAccuracy * a.taskCount, 0) / Math.max(1, taEntries.reduce((s, a) => s + a.taskCount, 0))) : null
      const cuEntries = agentsForModel.filter(a => a.contextUsage != null)
      contextUsage = cuEntries.length > 0 ? Math.round(cuEntries.reduce((s, a) => s + a.contextUsage * a.taskCount, 0) / Math.max(1, cuEntries.reduce((s, a) => s + a.taskCount, 0))) : null
      const trEntries = agentsForModel.filter(a => a.toolRelevance != null)
      toolRelevance = trEntries.length > 0 ? Math.round(trEntries.reduce((s, a) => s + a.toolRelevance * a.taskCount, 0) / Math.max(1, trEntries.reduce((s, a) => s + a.taskCount, 0))) : null
      const hlEntries = agentsForModel.filter(a => a.humanLikeness != null)
      humanLikeness = hlEntries.length > 0 ? Math.round(hlEntries.reduce((s, a) => s + a.humanLikeness * a.taskCount, 0) / Math.max(1, hlEntries.reduce((s, a) => s + a.taskCount, 0))) : null
    }

    return {
      model,
      provider: vol.provider,
      agents: vol.agents,
      taskCount: vol.taskCount,
      completed: vol.completed,
      failed: vol.failed,
      successRate,
      avgDurationMs,
      hallucinationScore,
      hallucinationRate: Math.max(0, Math.min(100, 100 - hallucinationScore)),
      outputQuality,
      scopeAdherence,
      toolAccuracy,
      contextUsage,
      toolRelevance,
      humanLikeness,
      avgTokens,
      avgActions,
    }
  })

  // Exclude models with zero completed tasks — they'd all share the same
  // placeholder defaults (60/80/100) and make the chart look identical.
  // Also exclude 'auto' (not a real model) and 'unknown' (unset).
  const filtered = byModel.filter(m => m.completed > 0 && m.model !== 'auto' && m.model !== 'unknown')

  // Sort by a composite "fit score" — higher is better. Weighted blend of
  // success rate, output quality, hallucination resistance, and speed.
  for (const m of filtered) {
    const speedScore = m.avgDurationMs > 0 ? Math.max(0, 100 - (m.avgDurationMs / 1000)) : 0
    const toolAcc = m.toolAccuracy ?? 70
    m.fitScore = Math.round(
      (m.successRate * 0.20) +
      (m.outputQuality * 0.20) +
      (m.hallucinationScore * 0.15) +
      (toolAcc * 0.15) +
      (m.humanLikeness != null ? m.humanLikeness * 0.10 : 0) +
      (m.toolRelevance != null ? m.toolRelevance * 0.10 : 0) +
      (Math.min(speedScore, 100) * 0.10)
    )
  }
  filtered.sort((a, b) => b.fitScore - a.fitScore)

  return { byAgent, byModel: filtered, latestByAgentModel }
}
