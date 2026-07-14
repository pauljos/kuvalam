// apps/api/src/routes/analytics.routes.js
import { query } from '../db/pool.js'

// Approximate LLM pricing per 1M tokens (USD) — used for cost estimates
// Update these values when provider pricing changes
const TOKEN_COST_PER_M = {
  'gpt-4o':             { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':        { input: 0.15,  output: 0.60  },
  'gpt-4-turbo':        { input: 10.00, output: 30.00 },
  'gpt-3.5-turbo':      { input: 0.50,  output: 1.50  },
  'claude-3-5-sonnet':  { input: 3.00,  output: 15.00 },
  'claude-3-opus':      { input: 15.00, output: 75.00 },
  default:              { input: 2.50,  output: 10.00 }
}

function estimateCost(model, promptTokens, completionTokens) {
  const key = Object.keys(TOKEN_COST_PER_M).find(k => model?.includes(k)) || 'default'
  const rates = TOKEN_COST_PER_M[key]
  return ((promptTokens / 1_000_000) * rates.input) + ((completionTokens / 1_000_000) * rates.output)
}

export default async function analyticsRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate)

  // Get tenant analytics overview
  fastify.get('/tenants/:tenantId/analytics', async (req, reply) => {
    const { tenantId } = req.params

    const [
      agentStats,
      taskStats,
      workflowStats,
      knowledgeStats,
      approvalStats,
      recentActivity,
      tasksByDay,
      topAgents,
      tokenUsage
    ] = await Promise.all([
      // Agent counts
      query(
        `SELECT status, COUNT(*) as count FROM agents WHERE tenant_id = $1 GROUP BY status`,
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

      // Recent audit activity (last 10 events)
      query(
        `SELECT event_type, actor_type, actor_id, resource_type, action, created_at
         FROM audit_log
         WHERE tenant_id = $1
         ORDER BY created_at DESC LIMIT 10`,
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
    const tokenBreakdown = tokenUsage.rows.map(row => {
      const promptTokens = parseInt(row.prompt_tokens) || 0
      const completionTokens = parseInt(row.completion_tokens) || 0
      const costUsd = estimateCost(row.model, promptTokens, completionTokens)
      return {
        model: row.model || 'unknown',
        promptTokens,
        completionTokens,
        totalTokens: parseInt(row.total_tokens) || 0,
        estimatedCostUsd: Math.round(costUsd * 10000) / 10000 // 4 decimal places
      }
    })
    const totalCostUsd = tokenBreakdown.reduce((sum, r) => sum + r.estimatedCostUsd, 0)
    const totalTokensUsed = tokenBreakdown.reduce((sum, r) => sum + r.totalTokens, 0)

    return {
      data: {
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
        recentActivity: recentActivity.rows,
        tasksByDay: tasksByDay.rows,
        topAgents: topAgents.rows.map(a => ({
          ...a,
          task_count: parseInt(a.task_count),
          completed: parseInt(a.completed),
          failed: parseInt(a.failed),
          successRate: a.task_count > 0 ? Math.round((a.completed / a.task_count) * 100) : 0
        })),
        llmCost: {
          totalTokens: totalTokensUsed,
          estimatedCostUsd: Math.round(totalCostUsd * 10000) / 10000,
          byModel: tokenBreakdown
        }
      }
    }
  })
}
