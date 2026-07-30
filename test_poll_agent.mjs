import { resolve } from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: resolve(process.cwd(), 'apps/api/.env') });

const BASE = 'http://localhost:3001';
const TENANT_ID = '712a1cc2-84e8-46c9-9706-9470328bb892';

async function main() {
  const res1 = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'paul@acme.com', password: 'password123', tenantSlug: 'acme' })
  });
  const token = (await res1.json()).data.accessToken;
  const headers = { 'Authorization': 'Bearer ' + token, 'Origin': 'http://localhost:3000', 'Referer': 'http://localhost:3000/' };

  // Run task
  const r2 = await fetch(BASE + '/api/v1/tenants/' + TENANT_ID + '/agents/785ed267-62da-49d9-813d-3bef65b45561/tasks', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal: 'SELECT COUNT(*) FROM orders' })
  });
  const taskId = (await r2.json()).data.id;
  console.log('Task ID:', taskId);

  // Poll
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 8000));
    const r3 = await fetch(BASE + '/api/v1/tenants/' + TENANT_ID + '/agents/785ed267-62da-49d9-813d-3bef65b45561/tasks/' + taskId, { headers });
    const task = (await r3.json()).data;
    const actions = task.actions || [];
    const lastAction = actions[actions.length - 1];
    console.log(`Poll ${i+1}: ${task.status} | actions: ${actions.length} | last tool: ${lastAction?.skill || 'none'} | ${lastAction?.output?.success ? 'OK' : lastAction?.output?.error?.slice(0,100) || ''}`);
    if (task.status === 'COMPLETED' || task.status === 'FAILED' || task.status === 'STOPPED') {
      console.log('\nFinal result:', JSON.stringify(task.result).slice(0, 500));
      console.log('All actions:', actions.map(a => `${a.skill}(${JSON.stringify(a.input)}) => ${a.output?.success ? 'OK:'+JSON.stringify(a.output).slice(0,100) : 'ERR:'+(a.output?.error||'').slice(0,80)}`).join('\n  '));
      break;
    }
  }
}
main().catch(e => console.error(e));
