// apps/api/src/services/scheduler.service.js
// Cron-based workflow trigger scheduler
// Reads SCHEDULE-triggered workflows and fires executions on time

import { query } from '../db/pool.js'

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
 */
function msUntilNextFire(fields, now = new Date()) {
  // Search up to 366 days ahead to avoid infinite loops on bad configs
  const limit = new Date(now.getTime() + 366 * 24 * 60 * 60_000)
  const candidate = new Date(now)

  // Advance to the next whole minute
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)

  while (candidate < limit) {
    const mo = candidate.getMonth() + 1   // 1-12
    const d  = candidate.getDate()         // 1-31
    const wd = candidate.getDay()          // 0-6 Sun=0
    const h  = candidate.getHours()
    const m  = candidate.getMinutes()

    const monthOk = !fields.month || fields.month.has(mo)
    const domOk   = !fields.dom   || fields.dom.has(d)
    const dowOk   = !fields.dow   || fields.dow.has(wd)
    const hourOk  = !fields.hour  || fields.hour.has(h)
    const minOk   = !fields.minute || fields.minute.has(m)

    if (monthOk && domOk && dowOk && hourOk && minOk) {
      return candidate.getTime() - now.getTime()
    }

    candidate.setMinutes(candidate.getMinutes() + 1)
  }

  return null // No match found within a year — skip
}

// ─── Scheduler State ─────────────────────────────────────────────────────────

let schedulerInterval = null
const activeTimers = new Map()

export async function startScheduler() {
  console.log('[Scheduler] Starting workflow trigger scheduler...')

  // Check every 60s for new/updated scheduled workflows
  schedulerInterval = setInterval(loadScheduledWorkflows, 60_000)
  await loadScheduledWorkflows()
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
        console.warn(`[Scheduler] Could not parse cron "${cron}" for workflow ${wf.id}`)
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

          activeTimers.set(wf.id, { timer, cronKey, cron, name: wf.name })
          console.log(`[Scheduler] Scheduled "${wf.name}" every ${parsed.intervalMs / 60000}m`)
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
  } catch (err) {
    console.error('[Scheduler] Error loading scheduled workflows:', err.message)
  }
}

function clearWorkflowTimer(workflowId) {
  const entry = activeTimers.get(workflowId)
  if (entry) {
    clearInterval(entry.timer)
    clearTimeout(entry.timer)
    activeTimers.delete(workflowId)
  }
}

/**
 * Schedule the next exact-time fire for a workflow using setTimeout.
 * Re-queues itself after each execution so it remains accurate.
 */
function scheduleNextFire(wf, parsed) {
  const delay = msUntilNextFire(parsed.fields)
  if (!delay) {
    console.warn(`[Scheduler] No upcoming fire time for workflow "${wf.name}" cron "${wf.trigger.cron}" — skipping`)
    return
  }

  const timer = setTimeout(async () => {
    await triggerWorkflow(wf)
    // Re-schedule for the next occurrence
    const entry = activeTimers.get(wf.id)
    if (entry) scheduleNextFire(wf, parsed)
  }, delay)

  const nextFireAt = new Date(Date.now() + delay).toISOString()
  activeTimers.set(wf.id, { timer, cronKey: JSON.stringify(parsed), cron: wf.trigger.cron, name: wf.name, nextFireAt })
  console.log(`[Scheduler] Scheduled "${wf.name}" next at ${nextFireAt}`)
}

async function triggerWorkflow(wf) {
  try {
    console.log(`[Scheduler] Triggering workflow "${wf.name}" (scheduled)`)
    const { startWorkflowExecution } = await import('./workflow.service.js')
    const exec = await startWorkflowExecution(wf.tenant_id, wf.id, {
      context: { triggeredBy: 'SCHEDULE', triggeredAt: new Date().toISOString() }
    })
    console.log(`[Scheduler] Execution started: ${exec.id}`)
  } catch (err) {
    console.error(`[Scheduler] Failed to trigger workflow ${wf.id}:`, err.message)
  }
}

export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
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
