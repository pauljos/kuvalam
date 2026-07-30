// apps/api/src/services/scheduler.service.js
// Cron-based workflow trigger scheduler
// Reads SCHEDULE-triggered workflows and fires executions on time

import { query } from '../db/pool.js'
import { auditLog } from '../utils/audit.js'

// ─── Cron Parser ─────────────────────────────────────────────────────────────
//
// Supports standard 5-field cron: minute hour dom month dow
// Examples handled:
//   "*/5 * * * *"      — every 5 minutes (interval mode, uses setInterval)
//   "0 */2 * * *"      — every 2 hours    (interval mode, uses setInterval)
//   "0 9 * * *"        — daily at 09:00   (exact-time mode, uses setTimeout chain)
//   "30 8 * * 1"       — every Monday at 08:30
//   "0 9 * * 1-5"      — weekdays at 09:00
//   "0 9,17 * * *"     — daily at 09:00 and 17:00
//   "0 0 1 * *"        — first day of month at midnight

function parseCronField(field, min, max) {
  if (field === '*') return null // wildcard — matches any

  const values = new Set()

  for (const part of field.split(',')) {
    // */step
    const stepMatch = part.match(/^\*\/(\d+)$/)
    if (stepMatch) {
      const step = parseInt(stepMatch[1])
      for (let i = min; i <= max; i += step) values.add(i)
      continue
    }
    // range: a-b or a-b/step
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1])
      const to = parseInt(rangeMatch[2])
      const step = rangeMatch[3] ? parseInt(rangeMatch[3]) : 1
      for (let i = from; i <= to; i += step) values.add(i)
      continue
    }
    // single value
    const n = parseInt(part)
    if (!isNaN(n)) values.add(n)
  }

  return values.size > 0 ? values : null
}

/**
 * Parse a 5-field cron expression and return either:
 *   { mode: 'interval', intervalMs }  — for simple star-slash-N patterns (setInterval safe)
 *   { mode: 'exact', fields }         — for time-specific patterns (requires nextTick calculation)
 *   null                              — unparseable
 */
function parseCron(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const [minuteF, hourF, domF, monthF, dowF] = parts

  // Fast path: pure interval minutes "*/N * * * *"
  const minuteStep = minuteF.match(/^\*\/(\d+)$/)
  if (minuteStep && hourF === '*' && domF === '*' && monthF === '*' && dowF === '*') {
    return { mode: 'interval', intervalMs: parseInt(minuteStep[1]) * 60_000 }
  }

  // Fast path: pure interval hours "0 */N * * *"
  const hourStep = hourF.match(/^\*\/(\d+)$/)
  if (minuteF === '0' && hourStep && domF === '*' && monthF === '*' && dowF === '*') {
    return { mode: 'interval', intervalMs: parseInt(hourStep[1]) * 60 * 60_000 }
  }

  // Exact-time mode — parse all fields
  const fields = {
    minute: parseCronField(minuteF, 0, 59),
    hour: parseCronField(hourF, 0, 23),
    dom: parseCronField(domF, 1, 31),
    month: parseCronField(monthF, 1, 12),
    dow: parseCronField(dowF, 0, 6)  // 0 = Sunday
  }

  return { mode: 'exact', fields }
}

/**
 * Calculate milliseconds until the next cron fire after `now`.
 *
 * ── M2 Fix: DST / Timezone awareness ──────────────────────────────────────
 * The original implementation used `new Date()` (server local time) with no
 * timezone context. A "0 9 * * *" cron on a UK server would fire at 8am or
 * 10am on DST transition days.
 * Now accepts an IANA timezone string (e.g. "Europe/London") and converts
 * each candidate time to the trigger timezone before evaluating cron fields.
 * Falls back to UTC if no timezone is configured or if the timezone is invalid.
 *
 * @param {object} fields       - Parsed cron fields from parseCron()
 * @param {Date}   [now]        - Reference time (default: current time)
 * @param {string} [timezone]   - IANA timezone string, e.g. "America/New_York"
 */
function msUntilNextFire(fields, now = new Date(), timezone = 'UTC') {
  // Validate the timezone — fall back to UTC if invalid
  let tz = timezone
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz }).format(now)
  } catch {
    tz = 'UTC'
  }

  // Helper: get the local time-of-day parts in the target timezone
  function getLocalParts(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(date)
    const p = {}
    for (const { type, value } of parts) p[type] = parseInt(value, 10)
    // month in Intl is 1-12
    return { mo: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, m: p.minute, wd: date.getDay() }
    // NOTE: getDay() returns UTC day of week but we correct this via the candidate advance below
  }

  // Search up to 366 days ahead to avoid infinite loops on bad configs
  const limit = new Date(now.getTime() + 366 * 24 * 60 * 60_000)
  const candidate = new Date(now)

  // Advance to the next whole minute
  candidate.setUTCSeconds(0, 0)
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)

  while (candidate < limit) {
    const local = getLocalParts(candidate)

    // Day of week from local date in timezone (not UTC)
    const localDow = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short'
    }).format(candidate)
    const dowMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }
    const localDowNum = dowMap[localDow] ?? candidate.getDay()

    const monthOk = !fields.month || fields.month.has(local.mo)
    const domOk   = !fields.dom   || fields.dom.has(local.d)
    const dowOk   = !fields.dow   || fields.dow.has(localDowNum)
    const hourOk  = !fields.hour  || fields.hour.has(local.h)
    const minOk   = !fields.minute|| fields.minute.has(local.m)

    if (monthOk && domOk && dowOk && hourOk && minOk) {
      return candidate.getTime() - now.getTime()
    }

    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)
  }

  return null // No match found within a year — skip
}


// ─── Scheduler State ─────────────────────────────────────────────────────────

let schedulerInterval = null
let approvalCleanupInterval = null
const activeTimers = new Map()

export async function startScheduler() {
  // Check every 60s for new/updated scheduled workflows
  schedulerInterval = setInterval(loadScheduledWorkflows, 60_000)
  await loadScheduledWorkflows()

  // ── Auto-reject expired approvals every 5 minutes ──────────────────────────
  // autoRejectExpiredApprovals was previously exported but never called, causing
  // tasks to remain stuck as AWAITING_APPROVAL indefinitely after their deadline.
  approvalCleanupInterval = setInterval(async () => {
    try {
      const { autoRejectExpiredApprovals } = await import('./hitl.service.js')
      const count = await autoRejectExpiredApprovals()
      if (count > 0) {
        console.log(`[Scheduler] Auto-rejected ${count} expired approval(s)`)
      }
    } catch (err) {
      console.warn(`[Scheduler] Approval cleanup failed: ${err.message}`)
    }
  }, 5 * 60_000)

  // Run once immediately on startup to clean up any approvals that expired
  // while the server was offline (e.g. after a restart)
  setTimeout(async () => {
    try {
      const { autoRejectExpiredApprovals } = await import('./hitl.service.js')
      const count = await autoRejectExpiredApprovals()
      if (count > 0) {
        console.log(`[Scheduler] Startup cleanup: auto-rejected ${count} expired approval(s)`)
      }
    } catch { /* non-critical */ }
  }, 5000) // 5s delay to let DB connections stabilise

  // ── Auto-purge expired dashboard reports (nightly) ─────────────────────────
  // Run once a day to clean up soft-archived and TTL-expired reports
  setInterval(async () => {
    try {
      const { purgeExpiredReports } = await import('./reports.service.js')
      const count = await purgeExpiredReports()
      if (count > 0) {
        console.log(`[Scheduler] Purged ${count} expired/archived report(s)`)
      }
    } catch (err) {
      console.warn(`[Scheduler] Report purge failed: ${err.message}`)
    }
  }, 24 * 60 * 60 * 1000)
}


async function loadScheduledWorkflows() {
  try {
    const { rows: workflows } = await query(`
      SELECT w.id, w.tenant_id, w.trigger, w.name
      FROM workflows w
      WHERE w.status = 'ACTIVE'
        AND w.trigger->>'type' = 'SCHEDULE'
        AND w.trigger->>'cron' IS NOT NULL
    `)

    for (const wf of workflows) {
      const { cron, enabled = true } = wf.trigger

      if (!enabled) {
        clearWorkflowTimer(wf.id)
        continue
      }

      const parsed = parseCron(cron)
      if (!parsed) {
        continue
      }

      const existing = activeTimers.get(wf.id)
      const cronKey = JSON.stringify(parsed)

      // Only re-register if cron expression has changed
      if (!existing || existing.cronKey !== cronKey) {
        clearWorkflowTimer(wf.id)

        if (parsed.mode === 'interval') {
          // Simple periodic execution
          const timer = setInterval(async () => {
            await triggerWorkflow(wf)
          }, parsed.intervalMs)

          activeTimers.set(wf.id, { timer, timerType: 'interval', cronKey, cron, name: wf.name })
        } else {
          // Exact-time execution — schedule the next fire and re-queue after each run
          scheduleNextFire(wf, parsed)
        }
      }
    }

    // Clear timers for workflows no longer in DB / inactive
    const activeIds = new Set(workflows.map(w => w.id))
    for (const [id] of activeTimers) {
      if (!activeIds.has(id)) clearWorkflowTimer(id)
    }
  } catch {
    // Scheduler errors are non-critical
  }
}

export function clearWorkflowTimer(workflowId) {
  const entry = activeTimers.get(workflowId)
  if (entry) {
    // Use the correct clear function based on how the timer was created.
    // clearInterval and clearTimeout are NOT interchangeable on all runtimes.
    if (entry.timerType === 'interval') {
      clearInterval(entry.timer)
    } else {
      clearTimeout(entry.timer)
    }
    activeTimers.delete(workflowId)
  }
}


/**
 * Schedule the next exact-time fire for a workflow using setTimeout.
 * Re-queues itself after each execution so it remains accurate.
 */
function scheduleNextFire(wf, parsed) {
  // Read timezone from trigger config; default to UTC if not set
  const tz = wf.trigger?.timezone || 'UTC'
  const delay = msUntilNextFire(parsed.fields, new Date(), tz)
  if (!delay) {
    console.warn(`[Scheduler] No upcoming fire time for workflow "${wf.name}" cron "${wf.trigger.cron}" (tz: ${tz}) — skipping`)
    return
  }

  const timer = setTimeout(async () => {
    await triggerWorkflow(wf)
    // Re-schedule for the next occurrence
    const entry = activeTimers.get(wf.id)
    if (entry) scheduleNextFire(wf, parsed)
  }, delay)

  const nextFireAt = new Date(Date.now() + delay).toISOString()
  activeTimers.set(wf.id, { timer, timerType: 'timeout', cronKey: JSON.stringify(parsed), cron: wf.trigger.cron, name: wf.name, nextFireAt })
  console.log(`[Scheduler] Scheduled "${wf.name}" next at ${nextFireAt} (tz: ${tz})`)
}


async function triggerWorkflow(wf) {
  // ── Distributed lock: prevent double-firing in multi-instance deployments ──
  // Each API instance runs its own scheduler in-memory. Without a lock, every
  // instance fires the same workflow at the same cron tick.
  // We use Redis SET NX PX (set-if-not-exists with TTL) as a lightweight mutex.
  // Key: workflow:<id>:lock:<minute-bucket>  — unique per workflow per fire-minute.
  // TTL: 90s — long enough for the execution to start, short enough to not block
  //      the NEXT fire if this one is delayed.
  const lockTTLMs = 90_000
  const minuteBucket = Math.floor(Date.now() / 60_000) // changes every minute
  const lockKey = `scheduler:lock:${wf.id}:${minuteBucket}`

  try {
    const { getRedisConnection } = await import('./queue.service.js')
    const redis = getRedisConnection()
    // SET key value NX PX ttl — returns 'OK' if acquired, null if already held
    const acquired = await redis.set(lockKey, '1', 'NX', 'PX', lockTTLMs)
    if (!acquired) {
      // Another instance already acquired the lock for this minute — skip
      console.log(`[Scheduler] Lock already held for "${wf.name}" (${minuteBucket}) — skipping (multi-instance dedup)`)
      return
    }
  } catch {
    // Redis unavailable — fall through without lock (single-instance safe)
    console.warn(`[Scheduler] Redis lock unavailable for "${wf.name}" — proceeding without distributed lock`)
  }

  try {
    console.log(`[Scheduler] Triggering workflow "${wf.name}" (scheduled)`)
    const { startWorkflowExecution } = await import('./workflow.service.js')
    const exec = await startWorkflowExecution(wf.tenant_id, wf.id, {
      context: { triggeredBy: 'SCHEDULE', triggeredAt: new Date().toISOString() }
    })
    console.log(`[Scheduler] Execution started: ${exec.id}`)
    try {
      await auditLog({
        eventType: 'trigger.fired', tenantId: wf.tenant_id,
        actorType: 'SYSTEM', actorId: wf.id,
        resourceType: 'WorkflowTrigger', resourceId: wf.id,
        action: 'SCHEDULE_FIRED',
        metadata: { workflowId: wf.id, workflowName: wf.name, triggerType: 'SCHEDULE', cron: wf.trigger?.cron, executionId: exec.id }
      })
    } catch { /* non-critical */ }
  } catch (err) {
    console.error(`[Scheduler] Failed to trigger workflow ${wf.id}:`, err.message)
  }
}


export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
  }
  if (approvalCleanupInterval) {
    clearInterval(approvalCleanupInterval)
    approvalCleanupInterval = null
  }
  for (const [id] of activeTimers) clearWorkflowTimer(id)
  console.log('[Scheduler] Stopped')
}

export function getSchedulerStatus() {
  return {
    running: schedulerInterval !== null,
    scheduledWorkflows: [...activeTimers.entries()].map(([id, entry]) => ({
      id,
      name: entry.name,
      cron: entry.cron,
      nextFireAt: entry.nextFireAt || null
    }))
  }
}
