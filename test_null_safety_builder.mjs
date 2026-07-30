// Test: verify null-safety for workflow/connector/trigger creation
const API = 'http://localhost:3001/api/v1';
const ORIGIN = 'http://localhost:3000';

async function apiCall(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };
  if (token) headers.Authorization = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  const { data: loginResp } = await apiCall('POST', '/auth/login', {
    body: { email: 'paul@acme.com', password: 'password123', tenantSlug: 'acme' },
  });
  const inner = loginResp?.data || loginResp || {};
  const { accessToken, tenant } = inner;
  const T = tenant.id;

  console.log('═══ Test 1: Workflow with no steps ═══');
  let r = await apiCall('POST', `/tenants/${T}/builder/chat`, {
    body: { message: 'Create a daily reporting workflow', history: [] },
    token: accessToken,
  });
  const d1 = r.data?.data || r.data;
  console.log(`  Actions: ${d1.actions?.length || 0}`);
  for (const a of (d1.actions || [])) {
    console.log(`  ${a.success ? '✅' : '❌'} ${a.tool}: ${a.result?.name || a.result?.error || JSON.stringify(a.result)?.substring(0,60)}`);
  }

  console.log('\n═══ Test 2: Connector with no type ═══');
  r = await apiCall('POST', `/tenants/${T}/builder/chat`, {
    body: { message: 'Connect to slack', history: [] },
    token: accessToken,
  });
  const d2 = r.data?.data || r.data;
  console.log(`  Actions: ${d2.actions?.length || 0}`);
  for (const a of (d2.actions || [])) {
    console.log(`  ${a.success ? '✅' : '❌'} ${a.tool}: ${a.result?.name || a.result?.error || JSON.stringify(a.result)?.substring(0,60)}`);
  }

  console.log('\n═══ Test 3: Trigger with no workflowId ═══');
  r = await apiCall('POST', `/tenants/${T}/builder/chat`, {
    body: { message: 'Add a webhook trigger for my workflow', history: [] },
    token: accessToken,
  });
  const d3 = r.data?.data || r.data;
  console.log(`  Actions: ${d3.actions?.length || 0}`);
  for (const a of (d3.actions || [])) {
    console.log(`  ${a.success ? '✅' : '❌'} ${a.tool}: ${a.result?.name || a.result?.error || JSON.stringify(a.result)?.substring(0,60)}`);
  }

  console.log('\n═══ Test 4: Full "create notification workflow" ═══');
  r = await apiCall('POST', `/tenants/${T}/builder/chat`, {
    body: { message: 'Create a notification workflow that sends Slack alerts when a new lead comes in', history: [] },
    token: accessToken,
  });
  const d4 = r.data?.data || r.data;
  console.log(`  Actions: ${d4.actions?.length || 0}`);
  for (const a of (d4.actions || [])) {
    console.log(`  ${a.success ? '✅' : '❌'} ${a.tool}: ${a.result?.name || a.result?.error || JSON.stringify(a.result)?.substring(0,60)}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
