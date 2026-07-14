// apps/api/src/services/workflow.service.js
import { query } from '../db/pool.js'
import { AppError } from '../utils/errors.js'
import { auditLog } from '../utils/audit.js'
import { dispatchTask } from './task.service.js'
import { enqueueWorkflowStep } from './queue.service.js'
import { broadcastTelemetry } from './telemetry.service.js'

// Maximum time to wait for an agent task inside a workflow step (10 minutes)
const AGENT_TASK_TIMEOUT_MS = 10 * 60 * 1000

// ─── Template interpolation ───────────────────────────────────────────────────
// Supports {{var}} for whole-value substitution and {{step_id.path.to.value}}
// for dotted-path lookup into prior step outputs. Unknown vars are left as-is
// so the LLM can see what wasn't wired up.
//
// Examples:
//   context = { research: { answer: "42", refs: ["a","b"] }, name: "Alice" }
//   "Hi {{name}}, answer is {{research.answer}}"  → "Hi Alice, answer is 42"
//   "First ref: {{research.refs.0}}"              → "First ref: a"
//   "Whole prior step: {{research}}"              → "Whole prior step: {\"answer\":\"42\",…}"
export function interpolateTemplate(str, ctx = {}) {
  if (typeof str !== 'string' || !str) return str
  return str.replace(/\{\{\s*([\w.\[\]-]+)\s*\}\}/g, (match, expr) => {
    // Normalise a[0] to a.0 for uniform path walking
    const path = expr.replace(/\[(\d+)\]/g, '.$1').split('.')
    let cur = ctx
    for (const part of path) {
      if (cur == null) return match
      cur = cur[part]
    }
    if (cur === undefined) return match
    if (cur === null) return 'null'
    return typeof cur === 'string' ? cur : JSON.stringify(cur)
  })
}

// Deep-interpolate an object/array (used for HTTP body + headers).
export function interpolateDeep(value, ctx) {
  if (typeof value === 'string') return interpolateTemplate(value, ctx)
  if (Array.isArray(value)) return value.map(v => interpolateDeep(v, ctx))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = interpolateDeep(v, ctx)
    return out
  }
  return value
}

// Return list of {{var}} tokens found in a string (for validation/preview).
export function extractTemplateVars(str) {
  if (typeof str !== 'string') return []
  const out = new Set()
  const re = /\{\{\s*([\w.\[\]-]+)\s*\}\}/g
  let m
  while ((m = re.exec(str)) !== null) out.add(m[1])
  return [...out]
}

// ─── Safe condition evaluator for step routing ────────────────────────────────
// Supports: output.path.to.value OPERATOR literal
// Operators: ===  !==  >  <  >=  <=  includes
// Literals:  number, "string", 'string', true, false, null
function resolveDotPath(root, path) {
  let cur = root
  for (const part of path) {
    if (cur == null) return undefined
    cur = cur[part]
  }
  return cur
}

function evaluateCondition(expr, { output, context }) {
  const match = expr.trim().match(/^(.+?)\s*(===|!==|>=|<=|>|<|includes)\s*(.+)$/)
  if (!match) return false
  const [, lhsRaw, op, rhsRaw] = match

  // Resolve LHS — must start with "output." or "context."
  const lhsParts = lhsRaw.trim().split('.')
  let lhs
  if (lhsParts[0] === 'output') {
    lhs = resolveDotPath(output, lhsParts.slice(1))
  } else if (lhsParts[0] === 'context') {
    lhs = resolveDotPath(context, lhsParts.slice(1))
  } else {
    return false // disallow arbitrary property access
  }

  // Parse RHS to a safe literal
  const r = rhsRaw.trim()
  let rhs
  if (r === 'true') rhs = true
  else if (r === 'false') rhs = false
  else if (r === 'null') rhs = null
  else if (/^-?\d+(\.\d+)?$/.test(r)) rhs = parseFloat(r)
  else if (/^["'](.*)["']$/.test(r)) rhs = r.slice(1, -1)
  else return false // reject unsafe RHS

  switch (op) {
    case '===': return lhs === rhs
    case '!==': return lhs !== rhs
    case '>':   return typeof lhs === 'number' && lhs > rhs
    case '<':   return typeof lhs === 'number' && lhs < rhs
    case '>=':  return typeof lhs === 'number' && lhs >= rhs
    case '<=':  return typeof lhs === 'number' && lhs <= rhs
    case 'includes': return typeof lhs === 'string' && lhs.includes(String(rhs))
    default:    return false
  }
}

// Resolve a goto target (string id or numeric index) to an index
function resolveGoto(steps, goto) {
  if (goto === 'END') return steps.length
  if (typeof goto === 'number') return goto
  if (typeof goto === 'string') {
    const idx = steps.findIndex(s => s.id === goto)
    return idx >= 0 ? idx : -1
  }
  return -1
}

/**
 * Determine the next step index after stepIdx completes.
 * Evaluates step.routes[] if present, otherwise falls back to step.goto or stepIdx+1.
 */
function resolveNextStepIdx(steps, stepIdx, stepOutput, context) {
  const step = steps[stepIdx]

  // routes: [{ when: "output.confidence > 0.8", goto: "fast_track" }, { goto: "review" }]
  if (Array.isArray(step.routes) && step.routes.length > 0) {
    for (const route of step.routes) {
      // No condition = default/fallback route
      if (!route.when) {
        const idx = resolveGoto(steps, route.goto)
        return idx >= 0 ? idx : stepIdx + 1
      }
      if (evaluateCondition(route.when, { output: stepOutput, context })) {
        const idx = resolveGoto(steps, route.goto)
        return idx >= 0 ? idx : stepIdx + 1
      }
    }
    // No route matched — fall through to next
    return stepIdx + 1
  }

  // Simple unconditional goto
  if (step.goto !== undefined) {
    const idx = resolveGoto(steps, step.goto)
    return idx >= 0 ? idx : stepIdx + 1
  }

  // Default: next step in sequence
  return stepIdx + 1
}

// ─── Crew task awaiter ────────────────────────────────────────────────────────
async function awaitTask(taskId, timeoutMs = AGENT_TASK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (Date.now() > deadline) throw new Error(`Task ${taskId} timed out after ${timeoutMs / 60000} min`)
    await new Promise(r => setTimeout(r, 1500))
    const { rows: [t] } = await query(
      'SELECT status, result, error FROM agent_tasks WHERE id = $1', [taskId]
    )
    if (!t) throw new Error(`Task ${taskId} not found`)
    if (t.status === 'COMPLETED') return t.result
    if (t.status === 'FAILED') throw new Error(t.error || `Task ${taskId} failed`)
  }
}

export async function createWorkflow(tenantId, { name, description, trigger = { type: 'MANUAL' }, steps = [], onFailure = 'STOP', userId }) {
  const { rows: [wf] } = await query(
    `INSERT INTO workflows (tenant_id, name, description, trigger, steps, on_failure, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'DRAFT', $7) RETURNING *`,
    [tenantId, name, description, trigger, JSON.stringify(steps), onFailure, userId]
  )
  await auditLog({
    eventType: 'workflow.created', tenantId, actorId: userId, actorType: 'USER',
    resourceType: 'Workflow', resourceId: wf.id, action: 'CREATE_WORKFLOW'
  })
  return wf
}

export async function listWorkflows(tenantId) {
  const { rows } = await query(
    'SELECT * FROM workflows WHERE tenant_id = $1 ORDER BY created_at DESC',
    [tenantId]
  )
  return rows
}

export async function listExecutions(tenantId) {
  const { rows } = await query(
    `SELECT e.*, w.name as workflow_name FROM workflow_executions e
     JOIN workflows w ON w.id = e.workflow_id
     WHERE e.tenant_id = $1 ORDER BY e.started_at DESC`,
    [tenantId]
  )
  return rows
}

export async function getWorkflow(tenantId, id) {
  const { rows: [wf] } = await query(
    'SELECT * FROM workflows WHERE id = $1 AND tenant_id = $2',
    [id, tenantId]
  )
  if (!wf) throw new AppError('WORKFLOW_NOT_FOUND', 'Workflow not found', 404)
  return wf
}

export async function updateWorkflow(tenantId, id, { name, description, trigger, steps, onFailure, status, userId }) {
  const wf = await getWorkflow(tenantId, id)
  const fields = []
  const params = [tenantId, id]

  const addField = (name, value) => {
    if (value !== undefined) {
      params.push(value)
      fields.push(`${name} = $${params.length}`)
    }
  }

  addField('name', name)
  addField('description', description)
  if (trigger) addField('trigger', trigger)
  if (steps) addField('steps', JSON.stringify(steps))
  addField('on_failure', onFailure)
  addField('status', status)

  if (fields.length === 0) return wf

  const { rows: [updated] } = await query(
    `UPDATE workflows SET ${fields.join(', ')}, updated_at = NOW() WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    params
  )

  await auditLog({
    eventType: 'workflow.updated', tenantId, actorId: userId, actorType: 'USER',
    resourceType: 'Workflow', resourceId: id, action: 'UPDATE_WORKFLOW'
  })

  return updated
}

export async function startWorkflowExecution(tenantId, workflowId, { context = {} } = {}) {
  const { rows: [wf] } = await query(
    `SELECT * FROM workflows WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'`,
    [workflowId, tenantId]
  )
  if (!wf) throw new AppError('WORKFLOW_NOT_ACTIVE', 'Workflow is not active or does not exist', 422)

  const { rows: [exec] } = await query(
    `INSERT INTO workflow_executions (workflow_id, tenant_id, workflow_version, status, context, started_at)
     VALUES ($1, $2, $3, 'RUNNING', $4, NOW()) RETURNING *`,
    [workflowId, tenantId, wf.version, context]
  )

  await auditLog({
    eventType: 'workflow.execution_started', tenantId, actorId: exec.id, actorType: 'SYSTEM',
    resourceType: 'WorkflowExecution', resourceId: exec.id, action: 'START_EXECUTION'
  })

  // Enqueue the first step via BullMQ (falls back to setImmediate if Redis unavailable)
  await enqueueWorkflowStep(exec.id, wf.steps, 0, context, runWorkflowStep)

  return exec
}

export async function getExecution(tenantId, execId) {
  const { rows: [exec] } = await query(
    `SELECT e.*, w.name as workflow_name FROM workflow_executions e
     JOIN workflows w ON w.id = e.workflow_id
     WHERE e.id = $1 AND e.tenant_id = $2`,
    [execId, tenantId]
  )
  if (!exec) throw new AppError('EXECUTION_NOT_FOUND', 'Workflow execution not found', 404)

  const { rows: steps } = await query(
    'SELECT * FROM step_executions WHERE execution_id = $1 AND tenant_id = $2 ORDER BY started_at ASC',
    [execId, tenantId]
  )

  return { ...exec, steps }
}

// Exported so the BullMQ worker in queue.service.js can import and call it
export async function runWorkflowStep(execId, steps, stepIdx, context) {
  return runNextStep(execId, steps, stepIdx, context)
}

// ── Retry policy helpers ──────────────────────────────────────────────────────
// A step may declare:  step.retry = { attempts: 3, backoffMs: 1000, jitter?: 0.2 }
// - attempts: total tries INCLUDING the initial one (1 = no retry, cap 5)
// - backoffMs: fixed base wait between tries (linear multiplier by attempt, cap 30s per wait)
// - jitter: 0..1 randomness multiplier on backoff (default 0)
const MAX_RETRY_ATTEMPTS = 5
const MAX_RETRY_BACKOFF_MS = 30_000

function normaliseRetryPolicy(retry) {
  const attempts = Math.max(1, Math.min(Number(retry?.attempts) || 1, MAX_RETRY_ATTEMPTS))
  const backoffMs = Math.max(0, Math.min(Number(retry?.backoffMs) || 0, MAX_RETRY_BACKOFF_MS))
  const jitter = Math.max(0, Math.min(Number(retry?.jitter) || 0, 1))
  return { attempts, backoffMs, jitter }
}

function backoffFor(attemptIdx, policy) {
  // attemptIdx: 1-based try count that just failed (1 after 1st failure, etc.)
  const base = policy.backoffMs * attemptIdx // linear
  const jitterMs = policy.jitter > 0 ? Math.floor(Math.random() * base * policy.jitter) : 0
  return Math.min(base + jitterMs, MAX_RETRY_BACKOFF_MS)
}

async function runNextStep(execId, steps, stepIdx, context) {
  if (stepIdx >= steps.length) {
    // Look up the tenant first so downstream updates + telemetry can scope
    // themselves defensively (worker context has no RLS).
    const { rows: [exec] } = await query('SELECT tenant_id FROM workflow_executions WHERE id = $1', [execId])
    if (!exec) return
    await query(
      `UPDATE workflow_executions SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [execId, exec.tenant_id]
    )
    broadcastTelemetry(exec.tenant_id, 'workflow.completed', { execId })
    return
  }

  const step = steps[stepIdx]
  const startTime = Date.now()

  const { rows: [stepExec] } = await query(
    `INSERT INTO step_executions (execution_id, tenant_id, step_id, step_type, status, input, started_at)
     VALUES ($1, (SELECT tenant_id FROM workflow_executions WHERE id = $1), $2, $3, 'RUNNING', $4, NOW()) RETURNING *`,
    [execId, step.id || `step_${stepIdx}`, step.type, step.input || {}]
  )

  const { tenant_id: tenantId } = stepExec
  broadcastTelemetry(tenantId, 'workflow.step_started', { execId, stepIdx, stepId: step.id, type: step.type })

  // ── APPROVAL is special: it puts the execution into PENDING_APPROVAL and returns
  // early without producing an output. Handle it BEFORE the retry loop so retry
  // policy doesn't accidentally apply (approvals aren't retryable — a human
  // rejection is a semantic outcome, not a transient failure).
  if (step.type === 'APPROVAL') {
    try {
      await query(
        `UPDATE step_executions SET status = 'PENDING', input = $1 WHERE id = $2 AND tenant_id = $3`,
        [step.input, stepExec.id, tenantId]
      )
      await query(
        `UPDATE workflow_executions SET status = 'PENDING_APPROVAL', context = $1 WHERE id = $2 AND tenant_id = $3`,
        [{ ...context, currentStepIdx: stepIdx }, execId, tenantId]
      )
      await query(
        `INSERT INTO approval_requests (tenant_id, execution_id, step_id, requested_by, context, status, deadline)
         VALUES ($1, $2, $3, 'SYSTEM', $4, 'PENDING', NOW() + INTERVAL '24 hours')`,
        [tenantId, execId, stepExec.id, { step, context }]
      )
      broadcastTelemetry(tenantId, 'workflow.awaiting_approval', { execId, stepId: step.id })
      return
    } catch (err) {
      await query(
        `UPDATE step_executions SET status = 'FAILED', error = $1, duration_ms = $2, completed_at = NOW() WHERE id = $3 AND tenant_id = $4`,
        [JSON.stringify({ message: err.message }), Date.now() - startTime, stepExec.id, tenantId]
      )
      broadcastTelemetry(tenantId, 'workflow.step_failed', { execId, stepIdx, error: err.message })
      throw err
    }
  }

  const retryPolicy = normaliseRetryPolicy(step.retry)
  let output
  let lastErr = null

  for (let attempt = 1; attempt <= retryPolicy.attempts; attempt++) {
    try {
      output = await executeStepBody(step, context, { tenantId, execId })
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      if (attempt >= retryPolicy.attempts) break
      const waitMs = backoffFor(attempt, retryPolicy)
      broadcastTelemetry(tenantId, 'workflow.step_retrying', {
        execId, stepIdx, stepId: step.id, attempt, ofAttempts: retryPolicy.attempts, waitMs, error: err.message
      })
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs))
    }
  }

  try {
    if (lastErr) throw lastErr

    // ── Step completed ──────────────────────────────────────────────────────
    const duration = Date.now() - startTime
    await query(
      `UPDATE step_executions SET status = 'COMPLETED', output = $1, duration_ms = $2, completed_at = NOW() WHERE id = $3 AND tenant_id = $4`,
      [output, duration, stepExec.id, tenantId]
    )

    const updatedContext = { ...context, [step.id || `step_${stepIdx}`]: output }
    await query(`UPDATE workflow_executions SET context = $1 WHERE id = $2 AND tenant_id = $3`, [updatedContext, execId, tenantId])

    broadcastTelemetry(tenantId, 'workflow.step_completed', { execId, stepIdx, stepId: step.id, duration })

    // Resolve next step (conditional routing)
    const nextIdx = resolveNextStepIdx(steps, stepIdx, output, updatedContext)
    await runNextStep(execId, steps, nextIdx, updatedContext)

  } catch (err) {
    const duration = Date.now() - startTime
    await query(
      `UPDATE step_executions SET status = 'FAILED', error = $1, duration_ms = $2, completed_at = NOW() WHERE id = $3 AND tenant_id = $4`,
      [JSON.stringify({ message: err.message }), duration, stepExec.id, tenantId]
    )
    broadcastTelemetry(tenantId, 'workflow.step_failed', { execId, stepIdx, error: err.message })
    throw err
  }
}

/**
 * Execute the body of a single step in isolation. Returns the step's `output`
 * or throws. Used by:
 *   - runNextStep (wrapped in retry policy)
 *   - dryRunStep  (test-a-single-step endpoint)
 *
 * Does NOT touch step_executions / workflow_executions rows — the caller owns
 * DB lifecycle. APPROVAL is intentionally rejected here because it requires
 * caller-managed persistence; runNextStep handles APPROVAL directly.
 */
export async function executeStepBody(step, context, { tenantId, execId } = {}) {
  if (step.type === 'APPROVAL') {
    throw new Error('APPROVAL steps cannot be executed via executeStepBody — they require workflow persistence')
  }

  let output = {}

  // ── AGENT step ──────────────────────────────────────────────────────────
  if (step.type === 'AGENT') {
      const goal = interpolateTemplate(step.input.goal || '', context)
      const result = await dispatchTask({
        tenantId,
        agentId: step.input.agentId,
        goal,
        context
      })

      const deadline = Date.now() + AGENT_TASK_TIMEOUT_MS
      while (true) {
        if (Date.now() > deadline) {
          await query(`UPDATE agent_tasks SET status = 'FAILED', error = $1 WHERE id = $2`,
            ['Timed out waiting for workflow step', result.taskId])
          throw new Error(`Agent task ${result.taskId} timed out after ${AGENT_TASK_TIMEOUT_MS / 60000} minutes`)
        }
        await new Promise(r => setTimeout(r, 1500))
        const { rows: [task] } = await query(
          'SELECT status, result, error FROM agent_tasks WHERE id = $1', [result.taskId]
        )
        if (!task) throw new Error('Agent task record not found')
        if (task.status === 'COMPLETED') { output = task.result; break }
        if (task.status === 'FAILED') throw new Error(task.error || 'Agent task execution failed')
      }

    // ── CREW step ───────────────────────────────────────────────────────────
    // mode: "parallel" | "sequential" | "supervisor"
    // agents: [{ agentId, role, goal }]
    // supervisorAgentId + supervisorGoal (supervisor mode only)
    } else if (step.type === 'CREW') {
      const { mode = 'parallel', agents = [], supervisorAgentId, supervisorGoal } = step.input || {}
      if (agents.length === 0) throw new Error('CREW step requires at least one agent in input.agents')

      broadcastTelemetry(tenantId, 'crew.started', { execId, stepId: step.id, mode, agentCount: agents.length })

      const interpolate = (str, ctx) => interpolateTemplate(str || '', ctx)

      const crewOutputs = {}

      if (mode === 'parallel' || mode === 'supervisor') {
        // Dispatch all agents simultaneously
        const dispatched = await Promise.all(agents.map(async (member) => {
          const result = await dispatchTask({
            tenantId,
            agentId: member.agentId,
            goal: interpolate(member.goal, context),
            context,
            priority: 'HIGH'
          })
          return { member, taskId: result.taskId }
        }))

        // Wait for all to complete
        const pending = new Set(dispatched.map(d => d.taskId))
        const deadline = Date.now() + AGENT_TASK_TIMEOUT_MS
        while (pending.size > 0) {
          if (Date.now() > deadline) throw new Error('CREW parallel tasks timed out')
          await new Promise(r => setTimeout(r, 1500))
          for (const { member, taskId } of dispatched) {
            if (!pending.has(taskId)) continue
            const { rows: [t] } = await query(
              'SELECT status, result, error FROM agent_tasks WHERE id = $1', [taskId]
            )
            if (t?.status === 'COMPLETED') {
              crewOutputs[member.role || member.agentId] = t.result
              pending.delete(taskId)
              broadcastTelemetry(tenantId, 'crew.agent_completed', { execId, role: member.role, taskId })
            } else if (t?.status === 'FAILED') {
              crewOutputs[member.role || member.agentId] = { error: t.error }
              pending.delete(taskId)
              broadcastTelemetry(tenantId, 'crew.agent_failed', { execId, role: member.role, taskId, error: t.error })
            }
          }
        }

        // Supervisor synthesises all outputs
        if (mode === 'supervisor' && supervisorAgentId) {
          const synthGoal = supervisorGoal ||
            `You are the crew supervisor. Review and synthesise all crew member outputs below into a final, definitive response.\n\n` +
            Object.entries(crewOutputs)
              .map(([role, out]) => `=== ${role} ===\n${typeof out === 'string' ? out : JSON.stringify(out, null, 2)}`)
              .join('\n\n')

          broadcastTelemetry(tenantId, 'crew.supervisor_started', { execId })
          const supervisorResult = await dispatchTask({
            tenantId,
            agentId: supervisorAgentId,
            goal: synthGoal,
            context: { ...context, crewOutputs },
            priority: 'HIGH'
          })
          const supervisorOutput = await awaitTask(supervisorResult.taskId)
          output = { crewOutputs, supervisorSynthesis: supervisorOutput }
          broadcastTelemetry(tenantId, 'crew.supervisor_completed', { execId })
        } else {
          output = crewOutputs
        }

      } else if (mode === 'sequential') {
        // Each agent receives the previous agent's output in context
        let seqContext = { ...context }
        for (const member of agents) {
          const result = await dispatchTask({
            tenantId,
            agentId: member.agentId,
            goal: interpolate(member.goal, seqContext),
            context: seqContext,
            priority: 'HIGH'
          })
          const taskOutput = await awaitTask(result.taskId)
          crewOutputs[member.role || member.agentId] = taskOutput
          // Make this agent's output available to the next agent
          seqContext = { ...seqContext, [member.role || member.agentId]: taskOutput }
          broadcastTelemetry(tenantId, 'crew.agent_completed', { execId, role: member.role, taskId: result.taskId })
        }
        output = crewOutputs
      }

    // ── HTTP step ────────────────────────────────────────────────────────────
    } else if (step.type === 'HTTP') {
      const url = interpolateTemplate(step.input.url || '', context)
      const headers = interpolateDeep({ 'Content-Type': 'application/json', ...(step.input.headers || {}) }, context)
      const rawBody = interpolateDeep(step.input.body, context)
      const res = await fetch(url, {
        method: step.input.method || 'POST',
        headers,
        body: rawBody !== undefined && rawBody !== null
          ? (typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody))
          : undefined
      })
      const text = await res.text()
      try { output = JSON.parse(text) } catch { output = { response: text } }
      if (!res.ok) throw new Error(`HTTP request returned status ${res.status}: ${text}`)

    // ── APPROVAL step ────────────────────────────────────────────────────────
    // Handled by runNextStep BEFORE this function is called — kept here as a
    // no-op only so that the else-if chain reads cleanly. executeStepBody
    // throws for APPROVAL at the top of the function.
    } else if (step.type === 'APPROVAL') {
      throw new Error('APPROVAL should not reach executeStepBody')

    // ── SET step ─────────────────────────────────────────────────────────────
    // Deterministic variable assignment. `input.vars` is a map { name: value }.
    // Values are deep-interpolated so you can chain outputs into new names.
    //
    //   input: { vars: { customerName: "{{lookup.name}}", tier: "{{lookup.plan.tier}}" } }
    //
    // The output IS the resolved map, so downstream steps can also read
    // {{this_step_id.customerName}} exactly like any other step output.
    } else if (step.type === 'SET') {
      const vars = interpolateDeep(step.input?.vars || {}, context)
      output = vars

    // ── DELAY step ───────────────────────────────────────────────────────────
    // Pauses execution for a bounded amount of time. Capped at 15 minutes to
    // avoid holding a BullMQ worker slot forever — for longer waits use a
    // scheduled trigger to break the workflow into two.
    } else if (step.type === 'DELAY') {
      const raw = Number(step.input?.ms ?? step.input?.seconds * 1000 ?? 1000)
      const ms = Math.max(0, Math.min(raw, 15 * 60 * 1000))
      broadcastTelemetry(tenantId, 'workflow.delaying', { execId, stepId: step.id, ms })
      await new Promise(r => setTimeout(r, ms))
      output = { waited_ms: ms }

    // ── TRANSFORM step ───────────────────────────────────────────────────────
    // Pure data reshaping — no I/O. `input.template` is a JSON structure with
    // {{context.paths}} embedded; we deep-interpolate it. This is the go-to
    // step for "take the agent's output and repackage it for the HTTP step".
    //
    //   input: { template: { name: "{{lookup.name}}", tags: ["vip", "{{tier}}"] } }
    } else if (step.type === 'TRANSFORM') {
      output = interpolateDeep(step.input?.template ?? {}, context)

    // ── NOTIFY step ──────────────────────────────────────────────────────────
    // Convenience shortcut for the most common tool call: post a message to
    // Slack. Uses the tenant's active Slack connector. Equivalent to TOOL step
    // with slack__post_message, but pre-canned so builders don't need to know
    // the tool naming scheme.
    } else if (step.type === 'NOTIFY') {
      const channel = interpolateTemplate(step.input?.channel || '', context)
      const message = interpolateTemplate(step.input?.message || '', context)
      const { executeConnectorTool } = await import('./connector-tools.service.js')
      const result = await executeConnectorTool('slack__post_message', { channel, text: message }, tenantId)
      if (!result?.success) throw new Error(result?.error || 'Slack notify failed')
      output = result

    // ── TOOL step ────────────────────────────────────────────────────────────
    // Call any configured connector tool directly by name (e.g.
    // "jira__create_issue", "db__<slug>__query", "rest__<slug>__get_user").
    // `input.tool` = tool name, `input.args` = arguments passed as-is after
    // deep interpolation.
    } else if (step.type === 'TOOL') {
      const tool = String(step.input?.tool || '').trim()
      if (!tool) throw new Error('TOOL step requires input.tool (e.g. "slack__post_message")')
      const args = interpolateDeep(step.input?.args || {}, context)
      const { executeConnectorTool, CONNECTOR_TOOL_PREFIXES } = await import('./connector-tools.service.js')
      if (!CONNECTOR_TOOL_PREFIXES.some(p => tool.startsWith(p))) {
        throw new Error(`Tool "${tool}" is not a recognised connector tool. Prefixes: ${CONNECTOR_TOOL_PREFIXES.join(', ')}`)
      }
      const result = await executeConnectorTool(tool, args, tenantId)
      if (!result?.success) throw new Error(result?.error || `Tool ${tool} failed`)
      output = result

    // ── LOOP step ────────────────────────────────────────────────────────────
    // Iterate over an array from the context and run a sub-goal per item on a
    // chosen agent. Sequential execution (parallel loops belong in a CREW step
    // with mode=parallel). Bounded to 25 iterations to prevent runaway loops.
    //
    //   input: {
    //     itemsFrom: "lookup.results",   // dotted path into context
    //     agentId: "…",
    //     goalTemplate: "Summarise {{item.title}} in one line"
    //   }
    //
    // Inside the goalTemplate, `item` and `index` are exposed alongside the
    // normal context vars.
    } else if (step.type === 'LOOP') {
      const path = String(step.input?.itemsFrom || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
      let items = context
      for (const p of path) items = items?.[p]
      if (!Array.isArray(items)) throw new Error(`LOOP itemsFrom "${step.input?.itemsFrom}" did not resolve to an array`)
      const agentId = step.input?.agentId
      const goalTemplate = step.input?.goalTemplate || ''
      if (!agentId) throw new Error('LOOP step requires input.agentId')

      const capped = items.slice(0, 25)
      const results = []
      for (let i = 0; i < capped.length; i++) {
        const iterCtx = { ...context, item: capped[i], index: i }
        const goal = interpolateTemplate(goalTemplate, iterCtx)
        const dispatched = await dispatchTask({ tenantId, agentId, goal, context: iterCtx, priority: 'HIGH' })
        const iterOutput = await awaitTask(dispatched.taskId)
        results.push(iterOutput)
        broadcastTelemetry(tenantId, 'workflow.loop_iter', { execId, stepId: step.id, index: i, of: capped.length })
      }
      output = { iterations: results.length, truncated: items.length > capped.length, results }

    // ── PARALLEL step ────────────────────────────────────────────────────────
    // Fan-out: run a list of sub-steps in parallel with Promise.all and collect
    // every output. Use when you need to hit several APIs / agents at once and
    // then merge. This is the workflow-level analogue of Airflow's TaskGroup
    // or n8n's "Split In Batches" node.
    //
    //   input: {
    //     tasks: [
    //       { id: 'slack', type: 'NOTIFY', input: { channel: '#a', message: 'hi' } },
    //       { id: 'log',   type: 'HTTP',   input: { url: '…', method: 'POST', body: {} } }
    //     ]
    //   }
    //
    // Output shape: { tasks: { <task.id>: <output>, … }, errors: {…}, hasErrors: bool }
    // Individual task failures are captured, NOT thrown — the PARALLEL step
    // succeeds as long as it dispatched. Downstream steps can inspect
    // `.hasErrors` to decide what to do.
    // Nested PARALLEL is not permitted (bounded to one level to prevent fan-out
    // explosions). Max 10 sub-tasks. Each sub-task runs its own retry policy.
    } else if (step.type === 'PARALLEL') {
      const tasks = Array.isArray(step.input?.tasks) ? step.input.tasks : []
      if (tasks.length === 0) throw new Error('PARALLEL step requires input.tasks (non-empty array)')
      if (tasks.length > 10) throw new Error('PARALLEL step is capped at 10 sub-tasks')
      for (const t of tasks) {
        if (t?.type === 'PARALLEL') throw new Error('Nested PARALLEL is not permitted')
        if (t?.type === 'APPROVAL') throw new Error('APPROVAL cannot run inside PARALLEL')
      }
      broadcastTelemetry(tenantId, 'workflow.parallel_started', { execId, stepId: step.id, count: tasks.length })
      const outcomes = await Promise.all(tasks.map(async (subStep, idx) => {
        const subId = subStep.id || `task_${idx}`
        const policy = normaliseRetryPolicy(subStep.retry)
        let subOut, subErr = null
        for (let attempt = 1; attempt <= policy.attempts; attempt++) {
          try {
            subOut = await executeStepBody(subStep, context, { tenantId, execId })
            subErr = null
            break
          } catch (e) {
            subErr = e
            if (attempt >= policy.attempts) break
            const w = backoffFor(attempt, policy)
            if (w > 0) await new Promise(r => setTimeout(r, w))
          }
        }
        return { id: subId, output: subOut, error: subErr ? subErr.message : null }
      }))
      const outMap = {}, errMap = {}
      for (const o of outcomes) {
        if (o.error) errMap[o.id] = o.error
        else outMap[o.id] = o.output
      }
      const hasErrors = Object.keys(errMap).length > 0
      broadcastTelemetry(tenantId, 'workflow.parallel_completed', { execId, stepId: step.id, ok: Object.keys(outMap).length, failed: Object.keys(errMap).length })
      output = { tasks: outMap, errors: errMap, hasErrors }
    }

  return output
}

/**
 * Dry-run a single step with a caller-supplied context. Used by the
 * "Test step" button in the canvas builder. Does NOT persist anything, does
 * NOT interact with workflow_executions / step_executions.
 *
 * Refuses AGENT/CREW/LOOP/APPROVAL — those require agent tasks and/or workflow
 * persistence to make sense. Callers should surface a "not supported in test
 * mode" hint for those types.
 */
export async function dryRunStep(tenantId, step, context = {}) {
  if (!step?.type) throw new AppError('BAD_STEP', 'step.type is required', 422)
  const disallowed = new Set(['AGENT', 'CREW', 'LOOP', 'APPROVAL'])
  if (disallowed.has(step.type)) {
    throw new AppError('DRY_RUN_UNSUPPORTED', `${step.type} steps cannot be dry-run — they require workflow persistence or agent tasks`, 422)
  }
  const started = Date.now()
  try {
    const output = await executeStepBody(step, context, { tenantId, execId: null })
    return { ok: true, output, durationMs: Date.now() - started }
  } catch (err) {
    return { ok: false, error: err.message, durationMs: Date.now() - started }
  }
}

export async function resumeWorkflowExecution(tenantId, execId, { approved, notes, modifiedInput } = {}) {
  const { rows: [exec] } = await query(
    `SELECT * FROM workflow_executions WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING_APPROVAL'`,
    [execId, tenantId]
  )
  if (!exec) throw new AppError('EXECUTION_NOT_PAUSED', 'Execution is not waiting for approval', 422)

  const { rows: [wf] } = await query(
    `SELECT * FROM workflows WHERE id = $1`,
    [exec.workflow_id]
  )

  const stepIdx = exec.context.currentStepIdx
  const step = wf.steps[stepIdx]

  // Resolve step execution record
  const { rows: [stepExec] } = await query(
    `SELECT * FROM step_executions WHERE execution_id = $1 AND step_id = $2 AND status = 'PENDING' AND tenant_id = $3`,
    [execId, step.id || `step_${stepIdx}`, tenantId]
  )

  if (!approved) {
    // Rejected
    await query(
      `UPDATE step_executions SET status = 'FAILED', error = $1, completed_at = NOW() WHERE id = $2 AND tenant_id = $3`,
      [JSON.stringify({ message: 'Rejected by administrator', notes }), stepExec.id, tenantId]
    )
    await query(
      `UPDATE workflow_executions SET status = 'FAILED', error = $1, completed_at = NOW() WHERE id = $2 AND tenant_id = $3`,
      [JSON.stringify({ message: 'Rejected by administrator', notes }), execId, tenantId]
    )
    return { status: 'FAILED' }
  }

  // Approved
  const actualInput = modifiedInput || stepExec.input
  await query(
    `UPDATE step_executions SET status = 'COMPLETED', output = $1, completed_at = NOW() WHERE id = $2 AND tenant_id = $3`,
    [JSON.stringify({ approved: true, notes, actualInput }), stepExec.id, tenantId]
  )

  const updatedContext = { ...exec.context, [step.id || `step_${stepIdx}`]: { approved: true, notes, input: actualInput } }
  delete updatedContext.currentStepIdx

  await query(
    `UPDATE workflow_executions SET status = 'RUNNING', context = $1 WHERE id = $2 AND tenant_id = $3`,
    [updatedContext, execId, tenantId]
  )

  // Enqueue the next step via BullMQ
  await enqueueWorkflowStep(execId, wf.steps, stepIdx + 1, updatedContext, runWorkflowStep)

  return { status: 'RUNNING' }
}
