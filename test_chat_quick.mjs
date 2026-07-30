#!/usr/bin/env node
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
    console.log(`   ✅ Logged in, tenant: ${tenantId} (${auth.tenant.name})`);

    // Check LLM config
    const settings = await apiCall('GET', `/tenants/${tenantId}/settings`, null, token);
    const providers = settings.llm_config?.providers || {};
    const defaultProvider = settings.llm_config?.defaultProvider || Object.keys(providers)[0];
    console.log(`   ✅ Provider: ${defaultProvider}, Model: ${providers[defaultProvider]?.model}`);

    // Create conversation
    console.log('2️⃣  Creating conversation...');
    const conv = await apiCall('POST', `/tenants/${tenantId}/chat/conversations`, {
      title: 'Quick DB Test',
      model: providers[defaultProvider]?.model,
      provider: defaultProvider
    }, token);
    console.log(`   ✅ Conversation: ${conv.conversation.id}`);

    // Send message
    console.log('3️⃣  Sending: "Show me the top 5 buyers by order count from Northwind DB. Use JOIN to get company names."');
    const t0 = Date.now();
    const msg = await apiCall('POST', `/tenants/${tenantId}/chat/conversations/${conv.conversation.id}/messages`, {
      content: 'Show me the top 5 buyers by order count from the Northwind DB. Use JOIN to get company names, not just IDs.'
    }, token);
    console.log(`   ⏱️  Took ${Date.now() - t0}ms`);
    console.log(`   📝 Response:\n${msg.content}`);
    console.log('\n✅ CHAT TEST PASSED');
  } catch(e) {
    console.error('❌ FAILED:', e.message);
  }
  process.exit(0);
}
main();
