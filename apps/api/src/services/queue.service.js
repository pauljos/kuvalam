// apps/api/src/services/queue.service.js
// BullMQ-based job queue for async task and workflow execution
// Replaces setImmediate() fire-and-forget with reliable, retryable jobs

import { Queue, Worker, QueueEvents } from 'bullmq'
import IORedis from 'ioredis'

// ─── Redis Connection ─────────────────────────────────────────────────────────

let connection = null
let isRedisAvailable = false

export function getRedisConnection() {
  if (connection) return connection

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

  connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    lazyConnect: true,
  })

  connection.on('connect', () => {
    isRedisAvailable = true
  })

  connection.on('error', (err) => {
    if (isRedisAvailable) {
      isRedisAvailable = false
    }
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

export async function initQueues(logger) {
  try {
    const conn = getRedisConnection()
    await conn.connect()

    if (!isRedisAvailable) {
      if (logger) logger.warn('[Queue] Redis not available — using in-process fallback (setImmediate)')
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
      await executeTask(task, agent)
    }, {
      connection: conn,
      concurrency: parseInt(process.env.TASK_CONCURRENCY || '5'),
      limiter: { max: 10, duration: 1000 }  // Max 10 tasks/sec
    })

    taskWorker.on('completed', (job) => {
      // Task completion logged by task.service.js
    })

    taskWorker.on('failed', (job, err) => {
      // Job has exhausted all BullMQ retry attempts — log permanently-failed jobs
      // so ops/monitoring can see them (previously this was a silent no-op).
      if (logger) logger.error(
        { jobId: job?.id, attempts: job?.attemptsMade, err: err?.message },
        '[Queue] Agent task permanently failed after all retries'
      )
    })

    // ─── Workflow Step Worker ─────────────────────────────────────────────────
    const workflowWorker = new Worker('workflow-executions', async (job) => {
      const { runWorkflowStep } = await import('./workflow.service.js')
      const { execId, steps, stepIdx, context } = job.data
      await runWorkflowStep(execId, steps, stepIdx, context)
    }, {
      connection: conn,
      concurrency: parseInt(process.env.WORKFLOW_CONCURRENCY || '3'),
    })

    workflowWorker.on('failed', (job, err) => {
      // Job has exhausted all BullMQ retry attempts
      if (logger) logger.error(
        { jobId: job?.id, execId: job?.data?.execId, stepIdx: job?.data?.stepIdx, err: err?.message },
        '[Queue] Workflow step permanently failed after all retries'
      )
    })

    // ─── WhatsApp Message Worker ──────────────────────────────────────────────
    const whatsappWorker = new Worker('whatsapp-messages', async (job) => {
      const { processIncomingMessage } = await import('./whatsapp.service.js')
      await processIncomingMessage(job)
    }, {
      connection: conn,
      concurrency: parseInt(process.env.WHATSAPP_CONCURRENCY || '5'),
      limiter: { max: 20, duration: 1000 },  // WhatsApp rate limits — max 20/sec
    })

    whatsappWorker.on('completed', (job) => {
      if (logger) logger.info({ jobId: job.id }, '[WhatsApp] Message processed')
    })

    whatsappWorker.on('failed', (job, err) => {
      if (logger) logger.error({ jobId: job.id, error: err.message }, '[WhatsApp] Message processing failed')
    })

    workerInstances = [taskWorker, workflowWorker, whatsappWorker]

    // ─── Telegram Message Worker ──────────────────────────────────────────────
    const telegramWorker = new Worker('telegram-messages', async (job) => {
      const { processIncomingMessage } = await import('./telegram.service.js')
      await processIncomingMessage(job)
    }, {
      connection: conn,
      concurrency: parseInt(process.env.TELEGRAM_CONCURRENCY || '5'),
      limiter: { max: 30, duration: 1000 },  // Telegram rate limit: 30 msg/sec
    })

    telegramWorker.on('completed', (job) => {
      if (logger) logger.info({ jobId: job.id }, '[Telegram] Message processed')
    })

    telegramWorker.on('failed', (job, err) => {
      if (logger) logger.error({ jobId: job.id, error: err.message }, '[Telegram] Message processing failed')
    })

    workerInstances.push(telegramWorker)

    // ─── Knowledge Ingestion Worker ───────────────────────────────────────────
    // ── L1 Fix: BullMQ-backed document indexing (durable, retryable) ──────────
    const { createKnowledgeWorker, recoverStuckDocuments } = await import('./knowledge.service.js')
    const knowledgeWorker = await createKnowledgeWorker(conn, logger)
    workerInstances.push(knowledgeWorker)

    // Recover stuck PROCESSING documents from before a restart (5s delay for DB)
    setTimeout(() => recoverStuckDocuments().catch(() => {}), 5000)

    if (logger) {
      logger.info(
        { concurrency: process.env.TASK_CONCURRENCY || '5' },
        '[Queue] BullMQ workers initialised — tasks, workflows, knowledge and messaging will be processed'
      )
    }
    return true

  } catch (err) {
    if (logger) {
      logger.warn(
        { error: err.message, code: err.code },
        '[Queue] Failed to initialise BullMQ — falling back to in-process setImmediate. ' +
        'Tasks will still run but without retries, persistence, or horizontal scaling.'
      )
    }
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
    console.log(`[Queue] Enqueuing task ${task.id} via BullMQ (priority: ${task.priority || 'MEDIUM'})`)
    await taskQueue.add(
      `task:${task.id}`,
      { task, agent },
      {
        jobId: task.id,     // Deduplicate by task ID
        priority: task.priority === 'HIGH' ? 1 : task.priority === 'LOW' ? 10 : 5,
      }
    )
  } else {
    console.log(`[Queue] Enqueuing task ${task.id} via setImmediate fallback (Redis unavailable)`)
    // Fallback: in-process execution via setImmediate.
    // IMPORTANT: If executeTaskFn throws or the process crashes before the
    // task is marked RUNNING, the task would be orphaned at QUEUED forever.
    // We catch errors here and mark the task FAILED to prevent silent orphans.
    setImmediate(async () => {
      try {
        await executeTaskFn(task, agent)
      } catch (err) {
        console.error(`[Queue:fallback] Task ${task.id} failed:`, err.message)
        // Mark the task as FAILED if it's stuck in QUEUED or RUNNING.
        // executeTask sets status to RUNNING early, so we must handle both states.
        try {
          const { query } = await import('../db/pool.js')
          await query(
            `UPDATE agent_tasks SET status = 'FAILED', error = $1, completed_at = NOW()
             WHERE id = $2 AND status IN ('QUEUED', 'RUNNING')`,
            [err.message || 'Unknown error in fallback execution', task.id]
          )
        } catch (dbErr) {
          console.error(`[Queue:fallback] Failed to mark task ${task.id} as FAILED:`, dbErr.message)
        }
      }
    })
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
  } else {
    setImmediate(async () => {
      try {
        await runStepFn(execId, steps, stepIdx, context)
      } catch (err) {
        console.error(`[Queue:fallback] Workflow step ${execId}:${stepIdx} failed:`, err.message)
        // Mark the execution as FAILED so it doesn't stay stuck
        try {
          const { query } = await import('../db/pool.js')
          await query(
            `UPDATE workflow_executions SET status = 'FAILED', error = $1, completed_at = NOW()
             WHERE id = $2 AND status NOT IN ('COMPLETED','FAILED')`,
            [err.message, execId]
          )
        } catch (dbErr) {
          console.error(`[Queue:fallback] Failed to mark execution ${execId} as FAILED:`, dbErr.message)
        }
      }
    })
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
export async function shutdownQueues(logger) {
  if (logger) logger.info('[Queue] Shutting down workers...')
  await Promise.all(workerInstances.map(w => w.close()))
  if (connection) await connection.quit()
  if (logger) logger.info('[Queue] Workers shut down')
}
