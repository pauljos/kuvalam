// Test: Malayalam news agent creation via builder
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
  console.log(`Logged in: ${tenant?.name}`);

  // Request an agent for Malayalam news — typical user request
  const { status, data } = await apiCall('POST', `/tenants/${tenant.id}/builder/chat`, {
    body: { message: 'Create an agent that can provide top malayalam news daily', history: [] },
    token: accessToken,
  });

  console.log(`Status: ${status}`);
  const result = data?.data || data;
  console.log(`Message: "${result.message}"`);
  console.log(`Actions: ${result.actions?.length || 0}`);

  if (result.actions?.length > 0) {
    for (const a of result.actions) {
      console.log(`  ${a.success ? '✅' : '❌'} ${a.tool}: ${a.result?.name || a.result?.resourceType || JSON.stringify(a.result).substring(0,80)}`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
