// apps/worker/src/index.js
// Kuvalam BullMQ Worker Process
// Runs agent task and workflow step workers independently from the API.
// In production, scale this container horizontally for more throughput.

import 'dotenv/config'
import { Worker } from 'bullmq'
import IORedis from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const TASK_CONCURRENCY = parseInt(process.env.TASK_CONCURRENCY || '5')
const WORKFLOW_CONCURRENCY = parseInt(process.env.WORKFLOW_CONCURRENCY || '3')

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
})

connection.on('connect', () => console.log('[Worker] Redis connected'))
connection.on('error', (err) => console.error('[Worker] Redis error:', err.message))

// ─── Agent Task Worker ────────────────────────────────────────────────────────
const taskWorker = new Worker(
  'agent-tasks',
  async (job) => {
    const { executeTask } = await import('../../api/src/services/task.service.js')
    const { task, agent } = job.data
    console.log(`[Worker:task] Processing ${task.id} for agent ${agent.name}`)
    await executeTask(task, agent)
  },
  {
    connection,
    concurrency: TASK_CONCURRENCY,
    limiter: { max: 10, duration: 1000 },
  }
)

taskWorker.on('completed', (job) => console.log(`[Worker:task] ${job.data.task.id} completed`))
taskWorker.on('failed', (job, err) =>
  console.error(`[Worker:task] ${job?.data?.task?.id} failed (attempt ${job?.attemptsMade}):`, err.message)
)

// ─── Workflow Step Worker ─────────────────────────────────────────────────────
const workflowWorker = new Worker(
  'workflow-executions',
  async (job) => {
    const { runWorkflowStep } = await import('../../api/src/services/workflow.service.js')
    const { execId, steps, stepIdx, context } = job.data
    console.log(`[Worker:workflow] Step ${stepIdx} for exec ${execId}`)
    await runWorkflowStep(execId, steps, stepIdx, context)
  },
  {
    connection,
    concurrency: WORKFLOW_CONCURRENCY,
  }
)

workflowWorker.on('failed', (job, err) =>
  console.error(`[Worker:workflow] Step failed for exec ${job?.data?.execId}:`, err.message)
)

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[Worker] ${signal} received — draining queues...`)
  await Promise.all([taskWorker.close(), workflowWorker.close()])
  await connection.quit()
  console.log('[Worker] Clean shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log('[Worker] Kuvalam worker started', {
  taskConcurrency: TASK_CONCURRENCY,
  workflowConcurrency: WORKFLOW_CONCURRENCY,
  redis: REDIS_URL.replace(/:\/\/.*@/, '://***@'), // mask credentials if present
})
