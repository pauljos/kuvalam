import { query } from '../db/pool.js'

export default async function agentLogsRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }

  // GET /api/v1/tenants/:tenantId/agent-logs
  // Returns recent tasks grouped by agent — running tasks first, then completed/failed
  fastify.get('/tenants/:tenantId/agent-logs', auth, async (request, reply) => {
    try {
      const { limit = '30' } = request.query
      const tid = request.params.tenantId

      // 1. Get all agents (for grouping even those with zero tasks)
      const { rows: agents } = await query(
        `SELECT id, name, archetype, status, llm_model, llm_provider
         FROM agents WHERE tenant_id = $1 ORDER BY name`,
        [tid]
      )

      // 2. Get recent tasks across all agents
      const { rows: tasks } = await query(
        `SELECT t.id, t.agent_id, t.goal, t.status, t.result, t.error,
                t.created_at, t.started_at, t.completed_at,
                t.token_usage, t.actions,
                t.execution_checkpoint
         FROM agent_tasks t
         WHERE t.tenant_id = $1
         ORDER BY t.created_at DESC
         LIMIT $2`,
        [tid, Number(limit)]
      )

      // 3. Group tasks by agent
      const agentMap = new Map()
      for (const a of agents) {
        agentMap.set(a.id, {
          id: a.id,
          name: a.name,
          archetype: a.archetype,
          status: a.status,
          llmModel: a.llm_model,
          llmProvider: a.llm_provider,
          tasks: [],
          runningCount: 0,
          recentCompleted: 0,
          recentFailed: 0,
        })
      }

      for (const t of tasks) {
        let group = agentMap.get(t.agent_id)
        if (!group) {
          // Agent may have been deleted — still show the task under "Unknown"
          group = agentMap.get('__deleted__')
          if (!group) {
            group = {
              id: '__deleted__',
              name: 'Deleted Agents',
              archetype: null,
              status: 'DELETED',
              llmModel: null,
              llmProvider: null,
              tasks: [],
              runningCount: 0,
              recentCompleted: 0,
              recentFailed: 0,
            }
            agentMap.set('__deleted__', group)
          }
        }

        const taskSummary = {
          id: t.id,
          goal: t.goal,
          status: t.status,
          createdAt: t.created_at,
          startedAt: t.started_at,
          completedAt: t.completed_at,
          tokenUsage: t.token_usage,
          actionCount: Array.isArray(t.actions) ? t.actions.length : 0,
          hasCheckpoint: !!t.execution_checkpoint,
          error: t.error,
          resultPreview: t.result
            ? (typeof t.result === 'object'
              ? (t.result.output || t.result.summary || JSON.stringify(t.result)).slice(0, 200)
              : String(t.result).slice(0, 200))
            : null,
        }

        group.tasks.push(taskSummary)
        if (t.status === 'RUNNING' || t.status === 'PENDING') group.runningCount++
        else if (t.status === 'COMPLETED') group.recentCompleted++
        else if (t.status === 'FAILED' || t.status === 'CANCELLED') group.recentFailed++
      }

      // 4. Sort groups: running agents first, then by most recent task timestamp
      const groups = Array.from(agentMap.values())
        .filter(g => g.tasks.length > 0 || g.status === 'ACTIVE')
        .map(g => {
          // Compute latest task timestamp for ordering
          const latest = g.tasks.reduce((max, t) => {
            const ts = t.createdAt
            return !max || ts > max ? ts : max
          }, null)
          return { ...g, _latestTs: latest }
        })
        .sort((a, b) => {
          if (a.runningCount > 0 && b.runningCount === 0) return -1
          if (b.runningCount > 0 && a.runningCount === 0) return 1
          // Within same run status: most recent first
          const ta = a._latestTs ? new Date(a._latestTs).toISOString() : ''
          const tb = b._latestTs ? new Date(b._latestTs).toISOString() : ''
          if (ta && tb) return tb.localeCompare(ta)
          return 0
        })
        .map(({ _latestTs, ...rest }) => rest) // strip internal sort key

      return reply.send({
        success: true,
        data: {
          agents: groups,
          totalRunning: groups.reduce((s, g) => s + g.runningCount, 0),
        },
      })
    } catch (err) {
      request.log.error(err)
      return reply.status(500).send({ success: false, error: err.message })
    }
  })
}
