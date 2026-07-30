// apps/api/src/services/plan-limits.service.js
// Single source of truth for plan-based resource limits and rate limits.
// Import this anywhere a plan check is needed.

export const PLAN_LIMITS = {
  TRIAL:      { agents: 5,         kbs: 2,          workflows: 5,          connectors: 5,         members: 3,   tasksPerMin: 5  },
  FREE:       { agents: 5,         kbs: 5,          workflows: 5,          connectors: 5,         members: 3,   tasksPerMin: 10 },
  PRO:        { agents: 25,        kbs: 20,         workflows: 50,         connectors: 30,        members: 25,  tasksPerMin: 30 },
  ENTERPRISE: { agents: Infinity,  kbs: Infinity,   workflows: Infinity,   connectors: Infinity,  members: Infinity, tasksPerMin: 60 },
}

const DEFAULT_PLAN = 'TRIAL'

/**
 * Load the tenant's plan and enforce a resource count limit.
 * @param {string} tenantId
 * @param {'agents'|'kbs'|'workflows'|'connectors'|'members'} resource
 * @param {number} currentCount - already counted rows for this resource
 * @returns {{ plan: string, limit: number }}
 * @throws {AppError} if the limit is exceeded
 */
export async function checkPlanLimit(tenantId, resource, currentCount) {
  // Dynamically import to avoid circular dependency at module level
  const { query } = await import('../db/pool.js')
  const { AppError } = await import('../utils/errors.js')

  const { rows: [row] } = await query(
    'SELECT plan FROM tenants WHERE id = $1',
    [tenantId]
  )

  const plan = row?.plan || DEFAULT_PLAN
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS[DEFAULT_PLAN]
  const limit = limits[resource] ?? Infinity

  if (currentCount >= limit) {
    const labels = {
      agents:     'agents',
      kbs:        'knowledge bases',
      workflows:  'workflows',
      connectors: 'connectors',
      members:    'members',
    }
    throw new AppError(
      `${resource.toUpperCase()}_LIMIT_REACHED`,
      `Your ${plan} plan allows max ${limit} ${labels[resource] || resource}.`,
      402
    )
  }

  return { plan, limit }
}

/**
 * Resolve the per-minute task dispatch cap for the given tenant.
 * Falls back to the env var TASK_RATE_LIMIT or 20 if the tenant can't be looked up.
 */
export async function getTaskRateLimit(tenantId) {
  try {
    const { query } = await import('../db/pool.js')
    const { rows: [row] } = await query(
      'SELECT plan FROM tenants WHERE id = $1',
      [tenantId]
    )
    const plan = row?.plan || DEFAULT_PLAN
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS[DEFAULT_PLAN]
    return limits.tasksPerMin ?? 20
  } catch {
    // If the DB lookup fails (e.g. during startup), fall back to env/default
    return parseInt(process.env.TASK_RATE_LIMIT || '20')
  }
}

export default PLAN_LIMITS
