// E2E test for Builder bot — v3 (fixed response unpacking)
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
  console.log('═══════════════════════════════════════════');
  console.log('  BUILDER BOT — E2E TEST v3');
  console.log('═══════════════════════════════════════════\n');

  // ═══ Login ═══
  console.log('── Login ──');
  const { status: loginStatus, data: loginResp } = await apiCall('POST', '/auth/login', {
    body: { email: 'paul@acme.com', password: 'password123', tenantSlug: 'acme' },
  });
  const inner = loginResp?.data || loginResp || {};
  const { accessToken, user, tenant } = inner;
  console.log(`   ${loginStatus === 200 ? '✅' : '❌'} Status: ${loginStatus}`);
  console.log(`   User: ${user?.email} | Role: ${user?.role} | Tenant: ${tenant?.name}`);
  
  if (!tenant?.id || !accessToken) {
    console.log(`   ❌ Cannot proceed — login failed. Got: ${JSON.stringify(loginResp).slice(0,200)}`);
    return;
  }
  const token = accessToken;
  const tid = tenant.id;

  function ok(status) { return status === 200 ? '✅' : '❌'; }

  // ═══ Builder Context ═══
  console.log('\n── Builder Context ──');
  let r = await apiCall('GET', `/tenants/${tid}/builder/context`, { token });
  console.log(`   ${ok(r.status)} Status: ${r.status}`);
  if (r.data?.success) {
    const d = r.data.data;
    console.log(`   Providers: ${(d.providers||[]).map(p => `${p.name}:${p.model}`).join(', ') || 'none'}`);
    console.log(`   Counts: a${d.counts?.agents ?? '?'} w${d.counts?.workflows ?? '?'} c${d.counts?.connectors ?? '?'} kb${d.counts?.knowledgeBases ?? '?'} t${d.counts?.triggers ?? '?'}`);
  } else {
    console.log(`   ❌ ${JSON.stringify(r.data?.error || r.data).slice(0,200)}`);
  }

  // ═══ Builder Chat — list agents ═══
  console.log('\n── Builder Chat (list agents) ──');
  r = await apiCall('POST', `/tenants/${tid}/builder/chat`, { token, body: { message: 'List all agents in this organization', history: [] } });
  console.log(`   ${ok(r.status)} Status: ${r.status} | Success: ${r.data?.success}`);
  if (r.data?.success) {
    const reply = r.data.data?.message || '';
    console.log(`   Reply: ${reply.slice(0, 250)}`);
  } else {
    console.log(`   Error: ${JSON.stringify(r.data?.error || r.data).slice(0, 200)}`);
  }

  // ═══ Builder Chat — create KB ═══
  console.log('\n── Builder Chat (create KB) ──');
  r = await apiCall('POST', `/tenants/${tid}/builder/chat`, { token, body: { message: 'Create a knowledge base called "Product FAQ" with description "Common product questions"', history: [] } });
  console.log(`   ${ok(r.status)} Status: ${r.status} | Success: ${r.data?.success}`);
  if (r.data?.success) {
    const reply = r.data.data?.message || '';
    console.log(`   Reply: ${reply.slice(0, 250)}`);
    (r.data.data?.actions || []).forEach(a => console.log(`   Action: ${a.tool} ${a.success ? '✅' : '❌'} ${a.result?.name || a.error || ''}`));
  } else {
    console.log(`   Error: ${JSON.stringify(r.data?.error || r.data).slice(0, 300)}`);
  }

  // ═══ Quick Agent ═══
  console.log('\n── Quick Agent ──');
  r = await apiCall('POST', `/tenants/${tid}/builder/quick-agent`, { token, body: { prompt: 'A support bot that answers customer questions about billing and refunds' } });
  console.log(`   ${ok(r.status)} Status: ${r.status} | Success: ${r.data?.success}`);
  if (r.data?.success) {
    (r.data.data?.actions || []).forEach(a => console.log(`   Action: ${a.tool} ${a.success ? '✅' : '❌'} ${a.result?.name || a.error || ''}`));
  } else {
    console.log(`   Error: ${JSON.stringify(r.data?.error || r.data).slice(0, 200)}`);
  }

  // ═══ Quick Workflow ═══
  console.log('\n── Quick Workflow ──');
  r = await apiCall('POST', `/tenants/${tid}/builder/quick-workflow`, { token, body: { prompt: 'Send a Slack notification and email digest every Monday at 9am' } });
  console.log(`   ${ok(r.status)} Status: ${r.status} | Success: ${r.data?.success}`);
  if (r.data?.success) {
    (r.data.data?.actions || []).forEach(a => console.log(`   Action: ${a.tool} ${a.success ? '✅' : '❌'} ${a.result?.name || a.error || ''}`));
  } else {
    console.log(`   Error: ${JSON.stringify(r.data?.error || r.data).slice(0, 200)}`);
  }

  // ═══ Frontend page ═══
  console.log('\n── Frontend Builder Page ──');
  const feRes = await fetch('http://localhost:3000/dashboard/builder', { redirect: 'manual' });
  console.log(`   ${feRes.status === 200 ? '✅' : '⚠️ '} Status: ${feRes.status}`);
  if (feRes.status === 200) {
    const text = await feRes.text();
    console.log(`   Has 'Builder': ${text.includes('Builder') ? '✅' : '❌'}`);
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  E2E TEST COMPLETE');
  console.log('═══════════════════════════════════════════');
}

main().catch(err => { console.error('\n❌ FATAL:', err.message); process.exit(1); });
