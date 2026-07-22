// apps/api/src/db/queue_kaggle_task.js
import 'dotenv/config'
import { dispatchTask } from '../services/task.service.js'

async function run() {
  try {
    const tenantId = 'e9e3f771-3062-4c7a-a53f-a0e0571a9ab3'
    const agentId = 'bab50a70-14d0-49da-84e7-7a46677e7d1f' // Kaggle Solver
    const userId = 'b47d19d7-5b70-49c8-acb4-3173d7db9ade'
    const goal = "List active Kaggle competitions using your kaggle_list_competitions tool, search for 'titanic' or 'spaceship-titanic', download the dataset files using your kaggle_download_files tool, write and run a simple python training script to build a baseline classification model (using RandomForest or similar in sklearn), generate a predictions submission.csv, and submit it to the competition using your kaggle_submit tool."

    console.log('Queuing Kaggle Solver task...')
    const result = await dispatchTask({
      tenantId,
      agentId,
      goal,
      userId,
      priority: 'HIGH'
    })
    console.log('✅ Kaggle Solver task queued successfully:', result)
    process.exit(0)
  } catch (err) {
    console.error('❌ Error queuing Kaggle task:', err)
    process.exit(1)
  }
}
run()
