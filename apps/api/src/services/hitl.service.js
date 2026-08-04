// apps/api/src/services/hitl.service.js
// Human-in-the-Loop (HITL) approval service
// Handles approval request lifecycle, autonomy enforcement, timeouts, and task resumption

import { query } from '../db/pool.js'
import { broadcastTelemetry } from './telemetry.service.js'
import { auditLog } from '../utils/audit.js'
import { AppError } from '../utils/errors.js'
import { enqueueTask } from './queue.service.js'

// ─── Constants ────────────────────────────────────────────────────────────────

export const AUTONOMY_LEVELS = {
  SUPERVISED: 'SUPERVISED',   // Always require approval for marked tools
  GUARDED: 'GUARDED',         // Require approval for high-risk tools only
  AUTONOMOUS: 'AUTONOMOUS',   // Never require approval
}

// Tools considered high-risk (require approval even in GUARDED mode, no manual marking needed)
export const HIGH_RISK_TOOLS = new Set([
  'ssh_exec',
  'docker_run',
  'http_request',
  'http_download',
])

// Built-in tools that automatically require approval in SUPERVISED mode
export const APPROVABLE_BUILTINS = new Set([
  'ssh_exec',
  'docker_run',
  'http_request',
  'http_download',
  'browser_use',
  'publish_dashboard_report',
  'a2a_call',
  'delegate_task',
  'write_artifact',
  'execute_sql',
])

const DEFAULT_TIMEOUT_MINUTES = 5
const POLL_INTERVAL_MS = 3000

// ─── Autonomy Enforcement ─────────────────────────────────────────────────────

/**
 * Determine whether a tool call requires human approval based on:
 * 1. Agent's autonomy level  — primary control
 * 2. Tool scopes (requires_approval marking) — optional override
 * 3. Tool risk classification — automatic for GUARDED/SUPERVISED
 *
 * Levels:
 *   AUTONOMOUS  — never ask, run everything without approval
 *   GUARDED     — ask only for HIGH_RISK_TOOLS (ssh/docker/http) or explicitly marked tools
 *   SUPERVISED  — ask for ALL tools in APPROVABLE_BUILTINS or explicitly marked tools
 */
export function requiresApproval({ toolName, autonomyLevel, hasApprovalScope }) {
  const level = autonomyLevel || AUTONOMY_LEVELS.SUPERVISED

  switch (level) {
    case AUTONOMY_LEVELS.AUTONOMOUS:
      // Autonomous: run everything without approval, but still respect
      // explicit scope-level requires_approval — scopes are more granular
      // than the agent-wide autonomy setting.
      return hasApprovalScope

    case AUTONOMY_LEVELS.GUARDED:
      // Guarded: approve high-risk tools automatically, or any tool explicitly marked
      return HIGH_RISK_TOOLS.has(toolName) || hasApprovalScope

    case AUTONOMY_LEVELS.SUPERVISED:
      // Supervised: approve all approvable built-ins automatically, or any explicitly marked tool
      return APPROVABLE_BUILTINS.has(toolName) || hasApprovalScope

    default:
      return hasApprovalScope
  }
}

// ─── Approval Request Lifecycle ───────────────────────────────────────────────

/**
 * Create a new approval request and pause the task
 * @returns {Promise<{approvalId: string, deadline: Date}>}
 */
export async function createApprovalRequest({
  tenantId,
  agentId,
  taskId,
  toolName,
  toolInput,
  autonomyLevel,
  timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
  executionCheckpoint = null,
}) {
  const deadline = new Date(Date.now() + timeoutMinutes * 60 * 1000)

  const { rows: [approval] } = await query(
    `INSERT INTO approval_requests
     (tenant_id, agent_id, task_id, tool_name, tool_input, status, requested_by,
      context, deadline, timeout_minutes, autonomy_level)
     VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      tenantId,
      agentId,
      taskId,
      toolName,
      JSON.stringify(toolInput),
      agentId, // requested_by is the agent
      JSON.stringify({ autonomyLevel, toolName, toolInput }),
      deadline.toISOString(),
      timeoutMinutes,
      autonomyLevel,
    ]
  )

  // Update task status to AWAITING_APPROVAL and store checkpoint + approval_id
  await query(
    `UPDATE agent_tasks
     SET status = 'AWAITING_APPROVAL',
         approval_id = $1,
         execution_checkpoint = $2
     WHERE id = $3 AND tenant_id = $4`,
    [approval.id, executionCheckpoint ? JSON.stringify(executionCheckpoint) : null, taskId, tenantId]
  )

  await auditLog({
    eventType: 'approval.requested',
    tenantId,
    actorId: agentId,
    actorType: 'AGENT',
    resourceType: 'ApprovalRequest',
    resourceId: approval.id,
    action: 'REQUEST_APPROVAL',
    afterState: { toolName, toolInput, autonomyLevel, timeoutMinutes },
  })

  // Broadcast to connected UI clients
  broadcastTelemetry(tenantId, 'agent.approval_required', {
    taskId,
    approvalId: approval.id,
    tool: toolName,
    input: toolInput,
    autonomyLevel,
    deadline: deadline.toISOString(),
    timeoutMinutes,
  })

  return { approvalId: approval.id, deadline }
}

/**
 * Poll for approval decision. Returns the decision result.
 * This is an async function that properly yields the event loop.
 */
export async function waitForApprovalDecision(approvalId, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES) {
  const deadline = Date.now() + timeoutMinutes * 60 * 1000

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))

    const { rows: [approval] } = await query(
      'SELECT status, decision_note, modified_input FROM approval_requests WHERE id = $1',
      [approvalId]
    )

    if (!approval) {
      return { approved: false, error: 'Approval request not found', timeout: false }
    }

    if (approval.status === 'APPROVED') {
      return {
        approved: true,
        decisionNote: approval.decision_note,
        modifiedInput: approval.modified_input,
      }
    }

    if (approval.status === 'REJECTED') {
      return {
        approved: false,
        error: approval.decision_note || 'Action rejected by human reviewer',
        rejected: true,
        timeout: false,
      }
    }

    // Check deadline from DB (may differ from our local deadline if it was updated)
    if (approval.deadline && new Date(approval.deadline) < new Date()) {
      await autoRejectApproval(approvalId, 'Approval deadline exceeded')
      return {
        approved: false,
        error: 'Approval timeout: No response from human reviewer',
        timeout: true,
        rejected: true,
      }
    }
  }

  // Local deadline exceeded — auto-reject
  await autoRejectApproval(approvalId, 'Approval timeout: No response from human reviewer')
  return {
    approved: false,
    error: 'Approval timeout: No response from human reviewer',
    timeout: true,
    rejected: true,
  }
}

/**
 * Supervisor-initiated approval (G5).
 * Called by the tenant supervisor when it wants human intervention on a running
 * task without a specific tool call — e.g. "agent looping for 12 min, continue
 * or cancel?". Reuses the approval_requests table with initiator='SUPERVISOR'.
 */
export async function createSupervisorApproval({
  tenantId, agentId, taskId, reason, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
}) {
  const deadline = new Date(Date.now() + timeoutMinutes * 60 * 1000)
  try {
    const { rows: [approval] } = await query(
      `INSERT INTO approval_requests
        (tenant_id, agent_id, task_id, tool_name, tool_input, status, requested_by,
         context, deadline, timeout_minutes, autonomy_level, initiator, supervisor_reason)
       VALUES ($1, $2, $3, 'supervisor_review', $4, 'PENDING', $2, $5, $6, $7, 'SUPERVISED', 'SUPERVISOR', $8)
       RETURNING *`,
      [
        tenantId, agentId, taskId,
        JSON.stringify({ reason }),
        JSON.stringify({ initiator: 'SUPERVISOR', reason }),
        deadline.toISOString(), timeoutMinutes, reason,
      ]
    )

    await query(
      `UPDATE agent_tasks
       SET status = 'AWAITING_APPROVAL', approval_id = $1
       WHERE id = $2 AND tenant_id = $3 AND status = 'RUNNING'`,
      [approval.id, taskId, tenantId]
    )

    try {
      await auditLog({
        eventType: 'approval.requested_by_supervisor',
        tenantId, actorType: 'SYSTEM', actorId: 'tenant-supervisor',
        resourceType: 'ApprovalRequest', resourceId: approval.id,
        action: 'SUPERVISOR_REQUEST_APPROVAL', afterState: { reason, agentId, taskId },
      })
    } catch { /* non-critical */ }

    try {
      broadcastTelemetry(tenantId, 'agent.approval_required', {
        taskId, approvalId: approval.id, tool: 'supervisor_review',
        input: { reason }, autonomyLevel: 'SUPERVISED',
        deadline: deadline.toISOString(), timeoutMinutes,
        initiator: 'SUPERVISOR',
      })
    } catch { /* non-critical */ }

    return { approvalId: approval.id, deadline }
  } catch (err) {
    console.warn(`[HITL] Supervisor approval creation failed: ${err.message}`)
    return null
  }
}

/**
 * Automatically reject an expired approval request
 */
export async function autoRejectApproval(approvalId, reason) {
  const { rows: [approval] } = await query(
    `UPDATE approval_requests
     SET status = 'REJECTED',
         decision_note = $1,
         decided_at = NOW(),
         auto_rejected_at = NOW()
     WHERE id = $2 AND status = 'PENDING'
     RETURNING *`,
    [reason, approvalId]
  )

  if (!approval) return // Already decided

  await auditLog({
    eventType: 'approval.auto_rejected',
    tenantId: approval.tenant_id,
    actorId: 'SYSTEM',
    actorType: 'SYSTEM',
    resourceType: 'ApprovalRequest',
    resourceId: approvalId,
    action: 'AUTO_REJECT',
    afterState: { reason },
  })

  broadcastTelemetry(approval.tenant_id, 'agent.approval_timeout', {
    approvalId,
    taskId: approval.task_id,
    reason,
  })

  // Mark the task as failed
  if (approval.task_id) {
    await query(
      `UPDATE agent_tasks
       SET status = 'FAILED',
           error = $1,
           approval_id = NULL,
           completed_at = NOW()
       WHERE id = $2 AND status = 'AWAITING_APPROVAL'`,
      [reason, approval.task_id]
    )

    broadcastTelemetry(approval.tenant_id, 'agent.task_failed', {
      taskId: approval.task_id,
      agentId: approval.agent_id,
      error: reason,
    })
  }

  return approval
}

// ─── Decision Handling (Called from approvals.routes.js) ─────────────────────

/**
 * Handle an approval decision — approved or rejected.
 * If approved and linked to an agent task, triggers task resumption.
 * If approved and linked to a workflow execution, triggers workflow resume.
 */
export async function handleApprovalDecision({
  tenantId,
  approvalId,
  decision,
  decisionNote,
  decidedBy,
  modifiedInput,
  isSystemAdmin = false,
}) {
  // Get the approval request
  const { rows: [approval] } = await query(
    `SELECT * FROM approval_requests WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING'`,
    [approvalId, tenantId]
  )
  if (!approval) {
    throw new AppError('APPROVAL_NOT_PENDING', 'Approval request is not pending or does not exist', 404)
  }

  // ── Security: verify that the deciding user is an active member of THIS tenant ──
  // Without this check a user from Tenant B who knows the approvalId could
  // approve it — their JWT only needs to match any valid tenant, not this one.
  // System admins (isSystemAdmin=true) bypass this check — they have platform-wide access.
  if (!isSystemAdmin) {
    const { rows: [membership] } = await query(
      `SELECT id FROM tenant_members
       WHERE tenant_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
      [tenantId, decidedBy]
    )
    if (!membership) {
      throw new AppError('FORBIDDEN', 'You are not a member of this organization', 403)
    }
  }


  // Update the approval record
  const updateFields = [
    'status = $1',
    'decided_by = $2',
    'decided_at = NOW()',
    'decision_note = $3',
  ]
  const updateParams = [decision, decidedBy, decisionNote || null]

  if (modifiedInput && decision === 'APPROVED') {
    updateFields.push('modified_input = $4')
    updateParams.push(JSON.stringify(modifiedInput))
  }

  updateParams.push(approvalId)
  const { rows: [updated] } = await query(
    `UPDATE approval_requests SET ${updateFields.join(', ')} WHERE id = $${updateParams.length} RETURNING *`,
    updateParams
  )

  await auditLog({
    eventType: `approval.${decision.toLowerCase()}`,
    tenantId,
    actorId: decidedBy,
    actorType: 'USER',
    resourceType: 'ApprovalRequest',
    resourceId: approvalId,
    action: `APPROVAL_${decision}`,
    afterState: { decisionNote, modifiedInput },
  })

  // Broadcast decision to UI
  broadcastTelemetry(tenantId, `agent.approval_${decision.toLowerCase()}`, {
    approvalId,
    taskId: approval.task_id,
    decisionNote,
    modifiedInput,
  })

  // ── Handle linked resources ────────────────────────────────────────────

  // 1. Linked to an agent task
  if (approval.task_id && decision === 'APPROVED') {
    try {
      await resumeAgentTask(tenantId, approval, modifiedInput)
    } catch (err) {
      console.error(`[HITL] Failed to resume task ${approval.task_id}:`, err.message)
    }
  }

  if (approval.task_id && decision === 'REJECTED') {
    try {
      await rejectAgentTask(tenantId, approval, decisionNote)
    } catch (err) {
      console.error(`[HITL] Failed to reject task ${approval.task_id}:`, err.message)
    }
  }

  // 2. Linked to a workflow execution
  if (approval.execution_id) {
    try {
      const { resumeWorkflowExecution } = await import('./workflow.service.js')
      await resumeWorkflowExecution(tenantId, approval.execution_id, {
        approved: decision === 'APPROVED',
        notes: decisionNote,
        modifiedInput: decision === 'APPROVED' ? modifiedInput : undefined,
      })
    } catch (err) {
      console.error(`[HITL] Failed to resume workflow ${approval.execution_id}:`, err.message)
    }
  }

  return updated
}

// ─── Task Resume / Reject ─────────────────────────────────────────────────────

/**
 * Resume an agent task after approval.
 * Restores the execution checkpoint and re-enqueues the task for continuation.
 * IMPORTANT: Does NOT set status to RUNNING — keeps it as AWAITING_APPROVAL to
 * avoid the idempotency check in executeTask (which skips RUNNING tasks).
 * executeTask's resume logic will detect the approved status and continue.
 */
async function resumeAgentTask(tenantId, approval, modifiedInput) {
  // Load the agent
  const { rows: [agent] } = await query(
    'SELECT a.*, t.llm_config FROM agents a JOIN tenants t ON t.id = a.tenant_id WHERE a.id = $1',
    [approval.agent_id]
  )

  if (!agent) {
    console.error(`[HITL] Agent ${approval.agent_id} not found for task resume`)
    return
  }

  // Load the task
  const { rows: [task] } = await query(
    'SELECT * FROM agent_tasks WHERE id = $1 AND tenant_id = $2',
    [approval.task_id, tenantId]
  )

  if (!task) return

  // Store the approval result in the task context so the execution loop can use it
  const resumeContext = {
    ...(task.context || {}),
    _resumeFromApproval: approval.id,
    _approvedTool: approval.tool_name,
    _approvedInput: modifiedInput || approval.tool_input,
    _decisionNote: approval.decision_note,
  }

  await query(
    `UPDATE agent_tasks SET context = $1 WHERE id = $2`,
    [JSON.stringify(resumeContext), approval.task_id]
  )

  broadcastTelemetry(tenantId, 'agent.task_resuming', {
    taskId: approval.task_id,
    agentId: agent.id,
    approvalId: approval.id,
  })

  // Re-enqueue the task for continuation
  // The task remains in AWAITING_APPROVAL status — executeTask's resume logic
  // will detect the approved state and continue execution.
  // Use a unique jobId to bypass BullMQ deduplication (original job same ID is in completed set).
  const { executeTask } = await import('./task.service.js')
  await enqueueTask(task, agent, executeTask, { jobId: `${task.id}-resume-${Date.now()}` })
}

/**
 * Mark a task as rejected when the human rejects the action.
 */
async function rejectAgentTask(tenantId, approval, decisionNote) {
  const reason = decisionNote || 'Action rejected by human reviewer'

  await query(
    `UPDATE agent_tasks
     SET status = 'FAILED',
         error = $1,
         approval_id = NULL,
         completed_at = NOW()
     WHERE id = $2 AND tenant_id = $3 AND status = 'AWAITING_APPROVAL'`,
    [reason, approval.task_id, tenantId]
  )

  broadcastTelemetry(tenantId, 'agent.task_rejected', {
    taskId: approval.task_id,
    agentId: approval.agent_id,
    reason,
    approvalId: approval.id,
  })
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Auto-reject all expired pending approvals.
 * Called periodically or on startup.
 */
export async function autoRejectExpiredApprovals() {
  const { rows: expired } = await query(
    `SELECT id FROM approval_requests
     WHERE status = 'PENDING'
       AND deadline IS NOT NULL
       AND deadline < NOW()
     LIMIT 100`
  )

  for (const { id } of expired) {
    try {
      await autoRejectApproval(id, 'Auto-rejected: Approval deadline exceeded')
    } catch (err) {
      console.error(`[HITL] Failed to auto-reject ${id}:`, err.message)
    }
  }

  return expired.length
}
