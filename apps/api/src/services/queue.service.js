// apps/api/src/services/queue.service.js
// BullMQ-based job queue for async task and workflow execution
// Replaces setImmediate() fire-and-forget with reliable, retryable jobs

import { Queue, Worker, QueueEvents } from 'bullmq'
import IORedis from 'ioredis'

// ─── Redis Connection ─────────────────────────────────────────────────────────

let connection = null
let isRedisAvailable = false

function getRedisConnection() {
  if (connection) return connection

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

  connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    lazyConnect: true,
  })

  connection.on('connect', () => {
    isRedisAvailable = true
    console.log('[Queue] Redis connected')
  })

  connection.on('error', (err) => {
    if (isRedisAvailable) {
      console.warn('[Queue] Redis error — falling back to in-process execution:', err.message)
    }
    isRedisAvailable = false
  })

  return connection
}

// ─── Queue Definitions ────────────────────────────────────────────────────────

let taskQueue = null
let workflowQueue = null
let workerInstances = []

const QUEUE_DEFAULTS = {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600, count: 1000 },  // Keep for 1 hour
    removeOnFail: { age: 86400 }                    // Keep failures for 24h
  }
}

// ─── Initialise Queues & Workers ─────────────────────────────────────────────

export async function initQueues() {
  try {
    const conn = getRedisConnection()
    await conn.connect()

    if (!isRedisAvailable) {
      console.warn('[Queue] Redis not available — using in-process fallback (setImmediate)')
      return false
    }

    // Task execution queue
    taskQueue = new Queue('agent-tasks', { connection: conn, ...QUEUE_DEFAULTS })

    // Workflow execution queue
    workflowQueue = new Queue('workflow-executions', { connection: conn, ...QUEUE_DEFAULTS })

    // ─── Task Worker ───────────────────────────────────────────────────────────
    const taskWorker = new Worker('agent-tasks', async (job) => {
      const { executeTask } = await import('./task.service.js')
      const { task, agent } = job.data

      console.log(`[Queue] Processing task ${task.id} for agent ${agent.name}`)
      await executeTask(task, agent)
    }, {
      connection: conn,
      concurrency: parseInt(process.env.TASK_CONCURRENCY || '5'),
      limiter: { max: 10, duration: 1000 }  // Max 10 tasks/sec
    })

    taskWorker.on('completed', (job) => {
      console.log(`[Queue] Task ${job.data.task.id} completed`)
    })

    taskWorker.on('failed', (job, err) => {
      console.error(`[Queue] Task ${job?.data?.task?.id} failed (attempt ${job?.attemptsMade}):`, err.message)
    })

    // ─── Workflow Step Worker ─────────────────────────────────────────────────
    const workflowWorker = new Worker('workflow-executions', async (job) => {
      const { runWorkflowStep } = await import('./workflow.service.js')
      const { execId, steps, stepIdx, context } = job.data

      console.log(`[Queue] Processing workflow step ${stepIdx} for execution ${execId}`)
      await runWorkflowStep(execId, steps, stepIdx, context)
    }, {
      connection: conn,
      concurrency: parseInt(process.env.WORKFLOW_CONCURRENCY || '3'),
    })

    workflowWorker.on('failed', (job, err) => {
      console.error(`[Queue] Workflow step failed for exec ${job?.data?.execId}:`, err.message)
    })

    workerInstances = [taskWorker, workflowWorker]

    console.log('[Queue] BullMQ workers initialised — task concurrency:', process.env.TASK_CONCURRENCY || '5')
    return true
  } catch (err) {
    console.warn('[Queue] Failed to initialise BullMQ:', err.message, '— using in-process fallback')
    return false
  }
}

// ─── Enqueue Functions ────────────────────────────────────────────────────────

/**
 * Enqueue an agent task job.
 * Falls back to setImmediate if Redis is unavailable.
 */
export async function enqueueTask(task, agent, executeTaskFn) {
  if (taskQueue && isRedisAvailable) {
    await taskQueue.add(
      `task:${task.id}`,
      { task, agent },
      {
        jobId: task.id,     // Deduplicate by task ID
        priority: task.priority === 'HIGH' ? 1 : task.priority === 'LOW' ? 10 : 5,
      }
    )
    console.log(`[Queue] Task ${task.id} enqueued`)
  } else {
    // Fallback: in-process execution
    setImmediate(() => executeTaskFn(task, agent).catch(err => {
      console.error(`[Queue:fallback] Task ${task.id} failed:`, err.message)
    }))
  }
}

/**
 * Enqueue a workflow step job.
 * Falls back to setImmediate if Redis is unavailable.
 */
export async function enqueueWorkflowStep(execId, steps, stepIdx, context, runStepFn) {
  if (workflowQueue && isRedisAvailable) {
    await workflowQueue.add(
      `step:${execId}:${stepIdx}`,
      { execId, steps, stepIdx, context },
      {
        jobId: `${execId}_${stepIdx}`,
        attempts: 2,  // Workflow steps are less retry-friendly
      }
    )
    console.log(`[Queue] Workflow step ${stepIdx} enqueued for exec ${execId}`)
  } else {
    setImmediate(() => runStepFn(execId, steps, stepIdx, context).catch(err => {
      console.error(`[Queue:fallback] Workflow step ${stepIdx} failed:`, err.message)
    }))
  }
}

/**
 * Get queue health stats.
 */
export async function getQueueStats() {
  if (!taskQueue || !isRedisAvailable) {
    return { available: false, message: 'Redis not connected — using in-process execution' }
  }

  const [taskCounts, workflowCounts] = await Promise.all([
    taskQueue.getJobCounts('active', 'waiting', 'completed', 'failed'),
    workflowQueue.getJobCounts('active', 'waiting', 'completed', 'failed'),
  ])

  return {
    available: true,
    tasks: taskCounts,
    workflows: workflowCounts,
  }
}

/**
 * Gracefully shut down all workers.
 */
export async function shutdownQueues() {
  console.log('[Queue] Shutting down workers...')
  await Promise.all(workerInstances.map(w => w.close()))
  if (connection) await connection.quit()
  console.log('[Queue] Workers shut down')
}
