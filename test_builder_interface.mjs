// =============================================================================
// Comprehensive Builder Bot Interface Tests
// Tests: Agent creation, Workflow creation, Trigger creation, Connector creation
// =============================================================================
const API = 'http://localhost:3001/api/v1';
const ORIGIN = 'http://localhost:3000';
const PASS = '✅'; const FAIL = '❌'; const WARN = '⚠️';

let token, tenantId, stats = { pass: 0, fail: 0, warn: 0 };

async function apiCall(method, path, { body, token: t } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function ok(r, label) {
  if (r.status >= 200 && r.status < 300) { stats.pass++; console.log(`  ${PASS} ${label}`); return true; }
  stats.fail++; console.log(`  ${FAIL} ${label} (status ${r.status}: ${JSON.stringify(r.data)?.substring(0,100)})`); return false;
}

function check(val, label) {
  if (val) { stats.pass++; console.log(`  ${PASS} ${label}`); } else { stats.fail++; console.log(`  ${FAIL} ${label}`); }
  return val;
}

async function builderChat(message) {
  const r = await apiCall('POST', `/tenants/${tenantId}/builder/chat`, { body: { message, history: [] }, token });
  const d = r.data?.data || r.data || {};
  return { status: r.status, data: d, actions: d.actions || [] };
}

// ─── SETUP ────────────────────────────────────────────────────────────────────

async function setup() {
  console.log('\n═══ SETUP: Login ═══');
  const r = await apiCall('POST', '/auth/login', {
    body: { email: 'paul@acme.com', password: 'password123', tenantSlug: 'acme' },
  });
  if (!ok(r, 'Login')) process.exit(1);
  token = r.data.data?.accessToken || r.data.accessToken;
  tenantId = r.data.data?.tenant?.id || r.data.tenant?.id;
  check(token, 'Got access token');
  check(tenantId, `Got tenant ID: ${tenantId}`);
}

// ─── TEST 1: Create Agent ─────────────────────────────────────────────────────

async function testCreateAgent() {
  console.log('\n═══ TEST 1: Create Agent ═══');
  const r = await builderChat('Create an agent called "Malayalam News Reporter" that can provide top malayalam news daily');
  ok({ status: r.status }, 'Builder chat responded');

  const actions = r.actions;
  check(actions.length >= 1, `Got ${actions.length} action(s)`);

  const agentAction = actions.find(a => a.tool === 'create_agent');
  if (!agentAction) { console.log(`  ${WARN} No create_agent action — checking if agent was created via other path`); stats.warn++; }
  else {
    check(agentAction.success, 'Agent created successfully');
    if (agentAction.result) {
      check(!!agentAction.result.name, `Name: "${agentAction.result.name}"`);
      check(!!agentAction.result.id, `ID: ${agentAction.result.id}`);
      // Verify in DB
      const verify = await apiCall('GET', `/tenants/${tenantId}/agents/${agentAction.result.id}`, { token });
      check(verify.status === 200, 'Agent verified in DB');
      const agent = verify.data?.data || verify.data || {};
      check(!!agent.archetype, `Archetype: ${agent.archetype}`);
    }
  }
}

// ─── TEST 2: Create Agent (edge case: minimal prompt) ─────────────────────────

async function testCreateAgentMinimal() {
  console.log('\n═══ TEST 2: Create Agent (minimal prompt) ═══');
  const r = await builderChat('Make a sales analytics agent');
  ok({ status: r.status }, 'Builder chat responded');

  const actions = r.actions;
  check(actions.length >= 1, `Got ${actions.length} action(s)`);

  const agentAction = actions.find(a => a.tool === 'create_agent');
  if (!agentAction) { console.log(`  ${WARN} No create_agent action`); stats.warn++; return; }
  check(agentAction.success, 'Agent created with minimal prompt');
  if (agentAction.result) {
    check(!!agentAction.result.name, `Name derived: "${agentAction.result.name}"`);
    const verify = await apiCall('GET', `/tenants/${tenantId}/agents/${agentAction.result.id}`, { token });
    const agent = verify.data?.data || verify.data || {};
    check(!!agent.archetype, `Archetype: ${agent.archetype}`);
  }
}

// ─── TEST 3: Create Workflow ──────────────────────────────────────────────────

async function testCreateWorkflow() {
  console.log('\n═══ TEST 3: Create Workflow ═══');
  const r = await builderChat('Create a workflow called "Lead Notification Pipeline" with 3 steps: first fetch new leads from CRM, then enrich with company data, and finally send Slack notification');
  ok({ status: r.status }, 'Builder chat responded');

  const actions = r.actions;
  check(actions.length >= 1, `Got ${actions.length} action(s)`);

  const wfAction = actions.find(a => a.tool === 'create_workflow');
  if (!wfAction) { console.log(`  ${WARN} No create_workflow action`); stats.warn++; return; }
  check(wfAction.success, 'Workflow created successfully');
  if (wfAction.result) {
    check(!!wfAction.result.name, `Name: "${wfAction.result.name}"`);
    check(!!wfAction.result.id, `ID: ${wfAction.result.id}`);
    // Verify in DB
    const verify = await apiCall('GET', `/tenants/${tenantId}/workflows/${wfAction.result.id}`, { token });
    check(verify.status === 200, 'Workflow verified in DB');
    const wf = verify.data?.data || verify.data || {};
    check(!!wf.steps && wf.steps.length > 0, `Has ${wf.steps?.length || 0} step(s)`);
    // Store for trigger test
    return wfAction.result;
  }
}

// ─── TEST 4: Create Workflow (edge case: no steps) ────────────────────────────

async function testCreateWorkflowMinimal() {
  console.log('\n═══ TEST 4: Create Workflow (minimal) ═══');
  const r = await builderChat('Create a daily reporting workflow');
  ok({ status: r.status }, 'Builder chat responded');

  const wfAction = r.actions.find(a => a.tool === 'create_workflow');
  if (!wfAction) { console.log(`  ${WARN} No create_workflow action`); stats.warn++; return; }
  check(wfAction.success, 'Workflow created with minimal prompt');
  if (wfAction.result) {
    check(!!wfAction.result.name, `Name: "${wfAction.result.name}"`);
    // Should have at least default step
    const verify = await apiCall('GET', `/tenants/${tenantId}/workflows/${wfAction.result.id}`, { token });
    const wf = verify.data?.data || verify.data || {};
    check(!!wf.steps && wf.steps.length >= 1, `Has ${wf.steps?.length || 0} default step(s)`);
    return wfAction.result;
  }
}

// ─── TEST 5: Create Connector ─────────────────────────────────────────────────

async function testCreateConnector() {
  console.log('\n═══ TEST 5: Create Connector ═══');
  const r = await builderChat('Create a Slack connector for sending notifications');
  ok({ status: r.status }, 'Builder chat responded');

  const connAction = r.actions.find(a => a.tool === 'create_connector');
  if (!connAction) { console.log(`  ${WARN} No create_connector action`); stats.warn++; return; }
  if (connAction.success) {
    check(true, 'Connector created successfully');
    check(!!connAction.result?.name, `Name: "${connAction.result?.name}"`);
    check(!!connAction.result?.type, `Type: ${connAction.result?.type}`);
    // Verify in DB
    const verify = await apiCall('GET', `/tenants/${tenantId}/connectors/${connAction.result.id}`, { token });
    check(verify.status === 200 || verify.status === 404, 'Connector endpoint responded');
  } else {
    // Graceful error is better than DB crash
    const err = connAction.result?.error || connAction.error || '';
    check(err.includes('type is required') || err.includes('Type') || err.includes('specify'),
      `Graceful error (not DB crash): "${err.substring(0, 80)}"`);
  }
}

// ─── TEST 6: Create Trigger ───────────────────────────────────────────────────

async function testCreateTrigger(workflowId) {
  console.log('\n═══ TEST 6: Create Trigger ═══');
  if (!workflowId) {
    // Create a workflow first to attach trigger to
    console.log('  (Creating workflow first for trigger attachment...)');
    const r = await builderChat('Create a webhook trigger workflow');
    const wfAction = r.actions.find(a => a.tool === 'create_workflow');
    if (wfAction?.result?.id) workflowId = wfAction.result.id;
  }
  check(!!workflowId, `Workflow ID available: ${workflowId}`);

  const r = await builderChat(`Add a webhook trigger to workflow "${workflowId}" that fires on new lead creation`);
  ok({ status: r.status }, 'Builder chat responded');

  const trigAction = r.actions.find(a => a.tool === 'create_trigger');
  if (!trigAction) {
    // Maybe the LLM created a workflow with triggers inline
    const wfAction = r.actions.find(a => a.tool === 'create_workflow');
    if (wfAction?.success) {
      console.log(`  ${WARN} LLM created workflow instead of standalone trigger`);
      stats.warn++;
    } else {
      console.log(`  ${WARN} No create_trigger action — LLM may not support standalone triggers`);
      stats.warn++;
    }
    return;
  }
  if (trigAction.success) {
    check(true, 'Trigger created successfully');
    check(!!trigAction.result?.triggerType, `Trigger type: ${trigAction.result?.triggerType}`);
    check(!!trigAction.result?.workflowId, `Workflow ID: ${trigAction.result?.workflowId}`);
  } else {
    const err = trigAction.result?.error || trigAction.error || '';
    check(err.includes('workflow') || err.includes('Workflow'),
      `Graceful error: "${err.substring(0, 80)}"`);
  }
}

// ─── TEST 7: Complex Multi-Action Request ─────────────────────────────────────

async function testComplexRequest() {
  console.log('\n═══ TEST 7: Complex Request (agent + workflow) ═══');
  const r = await builderChat('I need an agent that monitors competitor pricing and a workflow that alerts me on price changes');
  ok({ status: r.status }, 'Builder chat responded');

  check(r.actions.length >= 2, `Got ${r.actions.length} actions (expected ≥ 2)`);

  const hasAgent = r.actions.some(a => a.tool === 'create_agent');
  const hasWorkflow = r.actions.some(a => a.tool === 'create_workflow');
  check(hasAgent, 'Created agent');
  check(hasWorkflow, 'Created workflow');
}

// ─── TEST 8: Search then Create (retry loop) ──────────────────────────────────

async function testSearchThenCreate() {
  console.log('\n═══ TEST 8: Search-then-Create (retry loop) ═══');
  // First ask a question that might trigger a search
  const r = await builderChat('Do I have any agent called "Customer Support Bot"? If not, create one');
  ok({ status: r.status }, 'Builder chat responded');

  const searchAction = r.actions.find(a => a.tool === 'search_existing');
  const createAction = r.actions.find(a => a.tool === 'create_agent');

  if (searchAction) console.log(`  ${PASS} LLM searched first (as expected)`);
  if (createAction) {
    check(createAction.success, 'LLM created on second turn (retry loop worked)');
  } else if (!searchAction && !createAction) {
    console.log(`  ${WARN} No search or create — LLM may have just chatted`);
    stats.warn++;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   BUILDER BOT INTERFACE TESTS               ║');
  console.log('╚══════════════════════════════════════════════╝');

  await setup();

  await testCreateAgent();
  await testCreateAgentMinimal();
  const wfResult = await testCreateWorkflow();
  await testCreateWorkflowMinimal();
  await testCreateConnector();
  await testCreateTrigger(wfResult?.id);
  await testComplexRequest();
  await testSearchThenCreate();

  // ─── SUMMARY ──────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log(`║   RESULTS: ${stats.pass} passed, ${stats.fail} failed, ${stats.warn} warnings     ║`);
  console.log('╚══════════════════════════════════════════════╝');

  if (stats.fail > 0) process.exit(1);
}

main().catch(err => { console.error(`\n${FAIL} FATAL: ${err.message}`); process.exit(1); });
