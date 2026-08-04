// apps/api/src/services/tenant-supervisor.service.js
// ═══════════════════════════════════════════════════════════════════════════
// Tenant Supervisor — the "god" agent per tenant.
// ═══════════════════════════════════════════════════════════════════════════
// Runs on a 30-second tick from the main scheduler. Enforces runtime ceilings
// (G2), maintains the fleet-health table (G4), opens circuit breakers on
// repeated tool failures, and can escalate to a supervisor-initiated HITL
// approval (G5).
//
// Design goals:
//   • Pure Node — no LLM call in the hot path. Rules-based only.
//   • Tenant-scoped: every query strictly filters by tenant_id.
//   • Best-effort: any error inside the tick is caught and logged; the next
//     tick will try again. Never let the loop crash the scheduler.
//   • Idempotent: rerunning a tick is safe (only stops still-RUNNING tasks).
// ═══════════════════════════════════════════════════════════════════════════

import { query, tenantContextStore, releaseTenantClient } from '../db/pool.js'
import { auditLog } from '../utils/audit.js'
import { broadcastTelemetry } from './telemetry.service.js'

// ─── Tunables ────────────────────────────────────────────────────────────────
const STALE_HEARTBEAT_MS       = 10 * 60_000  // no update in 10 min → stale
const LOOP_ACTION_THRESHOLD    = 8            // same tool+input repeated
const CIRCUIT_FAILURE_RATE     = 0.7          // ≥70% failures in 24h opens breaker
const CIRCUIT_MIN_SAMPLE       = 5            // …but only after N completed tasks

// ─── Public: single tick ─────────────────────────────────────────────────────

export async function supervisorTick() {
  const startedAt = Date.now()
  const summary = { tenants: 0, tasksInspected: 0, actionsTaken: [] }

  try {
    const { rows: tenants } = await query(
      `SELECT DISTINCT tenant_id FROM agents WHERE status = 'ACTIVE'`
    )
    for (const { tenant_id: tenantId } of tenants) {
      summary.tenants++
      try {
        // Run each per-tenant tick inside an ALS context so RLS-enforced
        // deployments (non-owner DB role) still see agent_health / tenant_memory
        // rows for the current tenant. Explicitly release the pooled client on
        // exit — this is a cron path with no Fastify onResponse hook to do it.
        const store = { tenantId }
        const perTenant = await tenantContextStore.run(
          store,
          async () => {
            try {
              return await supervisorTickForTenant(tenantId)
            } finally {
              releaseTenantClient(store)
            }
          }
        )
        summary.tasksInspected += perTenant.tasksInspected
        summary.actionsTaken.push(...perTenant.actionsTaken)
      } catch (err) {
        console.warn(`[Supervisor] Tenant ${tenantId} tick failed: ${err.message}`)
      }
    }
  } catch (err) {
    console.warn(`[Supervisor] Tick failed: ${err.message}`)
  }

  const took = Date.now() - startedAt
  if (summary.actionsTaken.length > 0 || summary.tasksInspected > 0) {
    console.log(`[Supervisor] Tick: ${summary.tenants} tenants, ${summary.tasksInspected} tasks, ${summary.actionsTaken.length} actions, ${took}ms`)
  }
  return summary
}

// ─── Per-tenant work ─────────────────────────────────────────────────────────

export async function supervisorTickForTenant(tenantId) {
  const actionsTaken = []
  let tasksInspected = 0

  // 1) Load running tasks with their agent's runtime ceilings.
  const { rows: runningTasks } = await query(
    `SELECT t.id, t.agent_id, t.goal, t.started_at, t.actions, t.token_usage,
            a.name AS agent_name,
            a.max_actions_per_run,
            a.max_tool_calls_per_minute,
            a.max_cost_usd_per_task,
            a.max_wallclock_seconds
     FROM agent_tasks t
     JOIN agents a ON a.id = t.agent_id
     WHERE t.tenant_id = $1 AND t.status = 'RUNNING'`,
    [tenantId]
  )
  tasksInspected = runningTasks.length

  for (const task of runningTasks) {
    const violations = _evaluateTask(task)
    if (violations.length === 0) continue

    // Take the strongest action (cancel > pause > warn). For MVP we cancel.
    try {
      const reason = violations.map(v => v.reason).join('; ')
      await _cancelRunawayTask(tenantId, task, reason)
      actionsTaken.push({
        action: 'CANCELLED_RUNAWAY',
        taskId: task.id,
        agentId: task.agent_id,
        reasons: violations,
      })
    } catch (err) {
      console.warn(`[Supervisor] Failed to cancel task ${task.id}: ${err.message}`)
    }
  }

  // 2) Refresh fleet health for this tenant.
  try {
    await _refreshAgentHealth(tenantId)
  } catch (err) {
    console.warn(`[Supervisor] Failed to refresh health for ${tenantId}: ${err.message}`)
  }

  // 3) Evaluate circuit breakers based on 24h stats.
  try {
    const opened = await _evaluateCircuitBreakers(tenantId)
    for (const item of opened) actionsTaken.push(item)
  } catch (err) {
    console.warn(`[Supervisor] Circuit breaker eval failed for ${tenantId}: ${err.message}`)
  }

  return { tasksInspected, actionsTaken }
}

// ─── Rule evaluation ─────────────────────────────────────────────────────────

function _evaluateTask(task) {
  const violations = []
  const actions = Array.isArray(task.actions) ? task.actions : []
  const usage = task.token_usage || {}

  // Wall-clock ceiling.
  if (task.max_wallclock_seconds && task.started_at) {
    const elapsedMs = Date.now() - new Date(task.started_at).getTime()
    if (elapsedMs > task.max_wallclock_seconds * 1000) {
      violations.push({
        code: 'WALLCLOCK_EXCEEDED',
        reason: `elapsed ${Math.round(elapsedMs / 1000)}s exceeds max ${task.max_wallclock_seconds}s`,
      })
    }
  }

  // Stale heartbeat: task marked RUNNING but no new action for STALE_HEARTBEAT_MS.
  // We infer heartbeat from the timestamp on the last action; fall back to started_at.
  const lastActionAt = _lastActionTs(actions) || (task.started_at ? new Date(task.started_at).getTime() : null)
  if (lastActionAt && Date.now() - lastActionAt > STALE_HEARTBEAT_MS) {
    violations.push({
      code: 'STALE_HEARTBEAT',
      reason: `no activity for ${Math.round((Date.now() - lastActionAt) / 60_000)} min`,
    })
  }

  // Loop detection: same (tool, input) fingerprint N times in a row.
  const loopHit = _detectLoop(actions)
  if (loopHit) {
    violations.push({
      code: 'LOOP_DETECTED',
      reason: `tool "${loopHit.tool}" repeated ${loopHit.count}× with identical args`,
    })
  }

  // Cost ceiling — best effort; only if agent has ceiling AND task carries cost.
  if (task.max_cost_usd_per_task && typeof usage.cost_usd === 'number') {
    if (usage.cost_usd > Number(task.max_cost_usd_per_task)) {
      violations.push({
        code: 'COST_EXCEEDED',
        reason: `cost $${usage.cost_usd} exceeds max $${task.max_cost_usd_per_task}`,
      })
    }
  }

  // Rate ceiling: recent tool calls per minute.
  if (task.max_tool_calls_per_minute) {
    const cutoff = Date.now() - 60_000
    const recentCount = actions.filter(a => (_actionTs(a) || 0) >= cutoff).length
    if (recentCount > task.max_tool_calls_per_minute) {
      violations.push({
        code: 'TOOL_RATE_EXCEEDED',
        reason: `${recentCount} tool calls in last 60s exceeds max ${task.max_tool_calls_per_minute}/min`,
      })
    }
  }

  return violations
}

function _actionTs(action) {
  if (!action) return null
  const t = action.timestamp || action.ts || action.at
  if (!t) return null
  const parsed = new Date(t).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function _lastActionTs(actions) {
  for (let i = actions.length - 1; i >= 0; i--) {
    const t = _actionTs(actions[i])
    if (t) return t
  }
  return null
}

function _detectLoop(actions) {
  if (actions.length < LOOP_ACTION_THRESHOLD) return null
  const tail = actions.slice(-LOOP_ACTION_THRESHOLD)
  const first = tail[0]
  const tool = first?.tool || first?.name
  if (!tool) return null
  const fp = _fingerprint(first)
  const allSame = tail.every(a => _fingerprint(a) === fp && (a.tool || a.name) === tool)
  if (allSame) return { tool, count: LOOP_ACTION_THRESHOLD }
  return null
}

function _fingerprint(action) {
  try {
    const input = action?.input ?? action?.args ?? {}
    return JSON.stringify(input).slice(0, 500)
  } catch { return '' }
}

// ─── Task cancellation (supervisor-initiated) ────────────────────────────────

async function _cancelRunawayTask(tenantId, task, reason) {
  const { rowCount } = await query(
    `UPDATE agent_tasks
     SET status = 'CANCELLED',
         error = COALESCE(error, '') || $1,
         completed_at = NOW()
     WHERE id = $2 AND tenant_id = $3 AND status = 'RUNNING'`,
    [`\n[Supervisor] ${reason}`, task.id, tenantId]
  )
  if (rowCount === 0) return  // race — someone else finished it

  try {
    await auditLog({
      eventType: 'agent.task_cancelled_by_supervisor',
      tenantId,
      actorType: 'SYSTEM',
      actorId: 'tenant-supervisor',
      resourceType: 'AgentTask',
      resourceId: task.id,
      action: 'SUPERVISOR_CANCEL',
      metadata: { agentId: task.agent_id, reason },
    })
  } catch { /* audit is non-critical */ }

  try {
    broadcastTelemetry(tenantId, 'supervisor.task_cancelled', {
      taskId: task.id, agentId: task.agent_id, reason,
    })
  } catch { /* telemetry is non-critical */ }
}

// ─── Fleet health refresh ────────────────────────────────────────────────────

async function _refreshAgentHealth(tenantId) {
  // Aggregate stats over the last 24h per agent.
  const { rows: stats } = await query(
    `SELECT a.id AS agent_id,
            COUNT(*) FILTER (WHERE t.status = 'RUNNING')                    AS running,
            COUNT(*) FILTER (WHERE t.status = 'COMPLETED'
                                AND t.completed_at > NOW() - INTERVAL '24 hours') AS completed_24h,
            COUNT(*) FILTER (WHERE t.status = 'FAILED'
                                AND t.completed_at > NOW() - INTERVAL '24 hours') AS failed_24h,
            COUNT(*) FILTER (WHERE t.status = 'CANCELLED'
                                AND t.completed_at > NOW() - INTERVAL '24 hours') AS cancelled_24h,
            MAX(t.started_at)                                                AS last_task_at,
            MAX(t.completed_at) FILTER (WHERE t.status = 'COMPLETED')        AS last_success_at,
            MAX(t.completed_at) FILTER (WHERE t.status = 'FAILED')           AS last_failure_at,
            AVG(EXTRACT(EPOCH FROM (t.completed_at - t.started_at)) * 1000)
              FILTER (WHERE t.status = 'COMPLETED'
                       AND t.completed_at > NOW() - INTERVAL '24 hours')     AS avg_latency_ms
     FROM agents a
     LEFT JOIN agent_tasks t ON t.agent_id = a.id AND t.tenant_id = $1
     WHERE a.tenant_id = $1 AND a.status = 'ACTIVE'
     GROUP BY a.id`,
    [tenantId]
  )

  for (const row of stats) {
    await query(
      `INSERT INTO agent_health
         (agent_id, tenant_id, running_tasks, completed_24h, failed_24h, cancelled_24h,
          last_task_at, last_success_at, last_failure_at, avg_latency_ms, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         running_tasks   = EXCLUDED.running_tasks,
         completed_24h   = EXCLUDED.completed_24h,
         failed_24h      = EXCLUDED.failed_24h,
         cancelled_24h   = EXCLUDED.cancelled_24h,
         last_task_at    = EXCLUDED.last_task_at,
         last_success_at = EXCLUDED.last_success_at,
         last_failure_at = EXCLUDED.last_failure_at,
         avg_latency_ms  = EXCLUDED.avg_latency_ms,
         updated_at      = NOW()`,
      [
        row.agent_id, tenantId,
        Number(row.running) || 0,
        Number(row.completed_24h) || 0,
        Number(row.failed_24h) || 0,
        Number(row.cancelled_24h) || 0,
        row.last_task_at, row.last_success_at, row.last_failure_at,
        row.avg_latency_ms != null ? Math.round(Number(row.avg_latency_ms)) : null,
      ]
    ).catch(err => {
      console.warn(`[Supervisor] Health upsert failed for ${row.agent_id}: ${err.message}`)
    })
  }
}

// ─── Circuit breakers ────────────────────────────────────────────────────────

async function _evaluateCircuitBreakers(tenantId) {
  const opened = []
  const { rows } = await query(
    `SELECT agent_id, running_tasks, completed_24h, failed_24h, circuit_state, circuit_reason, circuit_opened_at
     FROM agent_health
     WHERE tenant_id = $1`,
    [tenantId]
  )
  for (const h of rows) {
    const total = Number(h.completed_24h) + Number(h.failed_24h)
    const failureRate = total > 0 ? Number(h.failed_24h) / total : 0

    // Open the breaker on excessive failure rate with a sample floor.
    // Skip if the circuit was manually reset within the last 60 minutes (grace period).
    const recentlyReset = h.circuit_reason === 'manual_reset' && h.circuit_opened_at &&
      new Date(h.circuit_opened_at) > new Date(Date.now() - 60 * 60_000)
    if (!recentlyReset && h.circuit_state === 'CLOSED' && total >= CIRCUIT_MIN_SAMPLE && failureRate >= CIRCUIT_FAILURE_RATE) {
      const reason = `failure rate ${(failureRate * 100).toFixed(0)}% over ${total} tasks in 24h`
      await query(
        `UPDATE agent_health
         SET circuit_state = 'OPEN', circuit_reason = $1, circuit_opened_at = NOW(), updated_at = NOW()
         WHERE agent_id = $2 AND tenant_id = $3`,
        [reason, h.agent_id, tenantId]
      )
      opened.push({ action: 'CIRCUIT_OPENED', agentId: h.agent_id, reason })
      try {
        await auditLog({
          eventType: 'agent.circuit_opened',
          tenantId, actorType: 'SYSTEM', actorId: 'tenant-supervisor',
          resourceType: 'Agent', resourceId: h.agent_id,
          action: 'OPEN_CIRCUIT', metadata: { reason, failureRate, sampleSize: total },
        })
      } catch { /* non-critical */ }
      try {
        broadcastTelemetry(tenantId, 'supervisor.circuit_opened', {
          agentId: h.agent_id, reason,
        })
      } catch { /* non-critical */ }
    }

    // Half-open probe after 30 min: allow next task to run.
    if (h.circuit_state === 'OPEN') {
      // Reset breaker after time has passed AND at least one recent success exists.
      if (failureRate < CIRCUIT_FAILURE_RATE || Number(h.completed_24h) > Number(h.failed_24h)) {
        await query(
          `UPDATE agent_health
           SET circuit_state = 'CLOSED', circuit_reason = NULL, circuit_opened_at = NULL, updated_at = NOW()
           WHERE agent_id = $1 AND tenant_id = $2
             AND (circuit_opened_at IS NULL OR circuit_opened_at < NOW() - INTERVAL '30 minutes')`,
          [h.agent_id, tenantId]
        )
      }
    }
  }
  return opened
}

// ─── Cheap accessor used by dispatchTask to refuse new work when circuit open ─

export async function isAgentCircuitOpen(agentId, tenantId) {
  try {
    const { rows: [row] } = await query(
      `SELECT circuit_state FROM agent_health WHERE agent_id = $1 AND tenant_id = $2`,
      [agentId, tenantId]
    )
    return row?.circuit_state === 'OPEN'
  } catch { return false }
}
