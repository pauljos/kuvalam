import { resolve } from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: resolve(process.cwd(), 'apps/api/.env') });

const BASE = 'http://localhost:3001';
const TENANT_ID = '712a1cc2-84e8-46c9-9706-9470328bb892';

async function main() {
  // Login with tenant slug
  const res1 = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'paul@acme.com', password: 'password123', tenantSlug: 'acme' })
  });
  const data1 = await res1.json();
  const token = data1.data.accessToken;
  console.log('Login:', res1.status, 'OK');

  // Get agents
  const res2 = await fetch(BASE + '/api/v1/tenants/' + TENANT_ID + '/agents', {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  const data2 = await res2.json();
  const agents = data2.data || data2.agents || data2 || [];
  const agentList = Array.isArray(agents) ? agents : (agents.agents || []);
  console.log('Agents:', agentList.map(a => a.id.slice(0,8) + ' ' + a.name));

  // Find Data Analytics Agent
  const da = agentList.find(a => a.name.toLowerCase().includes('data analytics'));
  if (!da) { console.log('Data Analytics Agent NOT FOUND'); process.exit(1); }
  console.log('Data Analytics Agent ID:', da.id);

  // Run task
  console.log('Running task: "How many orders are in the database? Just give me the count."');
  const res3 = await fetch(BASE + '/api/v1/tenants/' + TENANT_ID + '/agents/' + da.id + '/tasks', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Origin': 'http://localhost:3000', 'Referer': 'http://localhost:3000/' },
    body: JSON.stringify({ goal: 'How many orders are in the database? Just give me the count.' })
  });
  const data3 = await res3.json();
  console.log('Status:', data3.status);
  console.log('Result:', JSON.stringify(data3.result || data3.output || data3).slice(0, 800));
}

main().catch(e => console.error(e));
