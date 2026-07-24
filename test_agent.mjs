import { dispatchTask } from './apps/api/src/services/task.service.js';
import { query } from './apps/api/src/db/pool.js';

async function run() {
  try {
    console.log("Dispatching task...");
    const task = await dispatchTask({
      tenantId: '1185fa85-d0fc-41af-8843-ce946d468d46',
      agentId: '57431670-f532-48a5-b2ad-a58dc792386d',
      goal: 'Create a data analytics report with a chart and push it to the dashboard integration at http://localhost:3001/api/reports',
      userId: '1185fa85-d0fc-41af-8843-ce946d468d46' // assuming owner ID is same or doesn't matter much for dispatch
    });
    console.log('Task dispatched successfully:', task.id || task.taskId);
    
    let status = 'RUNNING';
    let result = null;
    let actions = [];
    while(status === 'RUNNING' || status === 'QUEUED') {
      await new Promise(r => setTimeout(r, 2000));
      const { rows } = await query('SELECT status, result, error, actions FROM agent_tasks WHERE id = $1', [task.id || task.taskId]);
      if (rows.length > 0) {
        status = rows[0].status;
        result = rows[0].result;
        actions = rows[0].actions;
        if (status === 'FAILED') {
          console.error('Task Failed:', rows[0].error);
        }
      }
    }
    console.log('Task finished with status:', status);
    console.log('Actions taken:');
    if (actions && Array.isArray(actions)) {
       actions.forEach(a => {
         console.log(`- ${a.skill}: ${a.success ? 'Success' : 'Failed'}`);
         if (a.skill === 'http_request') console.log(`  Target: ${a.input?.url}`);
       });
    }
    console.log('Result:', result);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

run();
