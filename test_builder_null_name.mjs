// Quick test: verify builder name fallback prevents DB null errors
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
  // Login
  const { data: loginResp } = await apiCall('POST', '/auth/login', {
    body: { email: 'paul@acme.com', password: 'password123', tenantSlug: 'acme' },
  });
  const inner = loginResp?.data || loginResp || {};
  const { accessToken, tenant } = inner;
  console.log(`Logged in: ${tenant?.name} (${tenant?.id})`);

  if (!tenant?.id || !accessToken) {
    console.error('Login failed', loginResp);
    process.exit(1);
  }

  // Send chat message requesting agent creation (LLM should return create_agent)
  console.log('\nSending builder chat message...');
  const { status, data } = await apiCall('POST', `/tenants/${tenant.id}/builder/chat`, {
    body: { message: 'Create a data analysis agent named "Insights Analyzer" that helps with SQL queries', history: [] },
    token: accessToken,
  });

  console.log(`Status: ${status}`);
  console.log(`Response:`, JSON.stringify(data, null, 2));

  // Verify no DB null errors
  if (data?.error) {
    console.log(`\n❌ Error: ${data.error.code} — ${data.error.message}`);
  } else if (data?.data?.actions?.length > 0) {
    const action = data.data.actions[0];
    console.log(`\n${action.success ? '✅' : '⚠️'} Action "${action.tool}": ${action.success ? 'success' : 'failed'}`);
    if (action.success) {
      console.log(`   Created: ${action.result?.name} (${action.result?.resourceType})`);
    } else {
      console.log(`   Error: ${action.error || action.result?.error}`);
    }
  } else {
    console.log(`\n⚠️ LLM didn't call create_agent — it just chatted back`);
    console.log(`   Message: "${(data?.data?.message || '').substring(0, 200)}"`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
