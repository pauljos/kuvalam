// apps/api/src/db/run_kaggle_task_direct.js
import 'dotenv/config'
import { executeTask, getTask } from '../services/task.service.js'
import { query } from './pool.js'

async function run() {
  try {
    const taskId = '7997a0ec-99fa-465a-a76d-a7da5ec8f610'
    const tenantId = 'e9e3f771-3062-4c7a-a53f-a0e0571a9ab3'

    // Fetch the task
    const task = await getTask(tenantId, taskId)
    console.log('Found task:', task.id)

    // Fetch the agent
    const { rows } = await query(
      `SELECT a.*, t.llm_config FROM agents a
       JOIN tenants t ON t.id = a.tenant_id
       WHERE a.id = $1 AND a.tenant_id = $2`,
      [task.agent_id, tenantId]
    )
    const agent = rows[0]
    if (!agent) throw new Error('Agent not found')
    console.log('Found agent:', agent.name)

    console.log('Executing Kaggle Solver task directly...')
    await executeTask(task, agent)
    console.log('✅ Kaggle Solver task finished execution!')
    process.exit(0)
  } catch (err) {
    console.error('❌ Error executing task:', err)
    process.exit(1)
  }
}
run()
