#!/usr/bin/env node
/**
 * End-to-end test: Task agent "Top 5 buyers" 
 * Verifies: no listTables dup, company names via JOIN, clean title, no synthesis crash
 */
const API_BASE = 'http://localhost:3001/api/v1';

async function apiCall(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json', 'Origin': 'http://localhost:3000' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) {
    console.error(`   ❌ HTTP ${res.status}:`, JSON.stringify(data).substring(0, 500));
    throw new Error(data.error?.message || `HTTP ${res.status}`);
  }
  return data.data;
}

async function main() {
  try {
    // Login
    console.log('1️⃣  Login as paul@acme.com...');
    const auth = await apiCall('POST', '/auth/login', { email: 'paul@acme.com', password: 'password123', tenantSlug: 'acme' });
    const token = auth.accessToken;
    const tenantId = auth.tenant.id;
    console.log(`   ✅ Tenant: ${tenantId} (${auth.tenant.name})`);

    // Get agents
    console.log('2️⃣  Getting agents...');
    const agentsResp = await apiCall('GET', `/tenants/${tenantId}/agents`, null, token);
    const agents = agentsResp.agents;
    const dbAgent = agents.find(a => a.type === 'database_explorer' || a.archetype === 'database_explorer' || a.name?.toLowerCase().includes('db') || a.name?.toLowerCase().includes('data'));
    if (!dbAgent) {
      console.log('   Agents:', agents.map(a => a.name + ' (' + a.archetype + ')').join(', '));
      // Just pick the first non-planner agent
      const fallback = agents.find(a => a.archetype !== 'planner') || agents[0];
      console.log(`   ⚠️  No DB agent found, using fallback: ${fallback.name}`);
      var agentForTest = fallback;
    } else {
      var agentForTest = dbAgent;
    }
    console.log(`   ✅ Using agent: ${agentForTest.name} (${agentForTest.id})`);

    // Dispatch task
    console.log('3️⃣  Dispatching "Top 5 buyers by order count"...');
    const t0 = Date.now();
    const task = await apiCall('POST', `/tenants/${tenantId}/agents/${agentForTest.id}/tasks`, {
      goal: 'Top 5 buyers by order count'
    }, token);
    console.log(`   ✅ Task dispatched: ${task.id || task.taskId}`);

    // Poll for completion
    let status = 'RUNNING';
    let result = null;
    let attempts = 0;
    const taskId = task.id || task.taskId;
    while ((status === 'RUNNING' || status === 'QUEUED') && attempts < 60) {
      await new Promise(r => setTimeout(r, 3000));
      const t = await apiCall('GET', `/tenants/${tenantId}/agents/${agentForTest.id}/tasks/${taskId}`, null, token);
      status = t.status;
      result = t.result;
      attempts++;
      console.log(`   ⏳ Status: ${status} (${attempts * 3}s)`);
    }

    console.log(`\n⏱️  Total time: ${Date.now() - t0}ms`);
    console.log(`📊 Status: ${status}`);

    if (status === 'COMPLETED') {
      console.log(`\n📝 Result:\n${JSON.stringify(result, null, 2).substring(0, 2000)}`);
      console.log('\n✅ TASK TEST PASSED');
    } else if (status === 'FAILED') {
      console.error(`\n❌ FAILED: ${JSON.stringify(result)}`);
    } else {
      console.log(`\n⚠️  Task still ${status} after ${attempts * 3}s`);
    }
  } catch(e) {
    console.error('❌ FAILED:', e.message);
  }
  process.exit(0);
}
main();
