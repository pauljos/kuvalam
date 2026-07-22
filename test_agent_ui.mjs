import puppeteer from 'puppeteer';

async function run() {
  console.log("1. Launching browser...");
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
  const fakeToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiZXhwIjozMzg4NDQwMDAwfQ.invalid-signature";
  await page.setCookie({ name: 'kuvalam_token', value: fakeToken, domain: 'localhost', path: '/', httpOnly: true });

  await page.evaluate((token) => {
    const fakeUser = { id: 'test-user-id', email: 'paul@acme.com', name: 'Paul' };
    const fakeTenant = { id: 'test-tenant-id', name: 'Acme', slug: 'acme', status: 'ACTIVE' };
    localStorage.setItem('kuvalam_access_token', token);
    localStorage.setItem('kuvalam_user', JSON.stringify(fakeUser));
    localStorage.setItem('kuvalam_tenant', JSON.stringify(fakeTenant));
    localStorage.setItem('kuvalam_tenants', JSON.stringify([fakeTenant]));
    localStorage.setItem('kuvalam_tenant_id', fakeTenant.id);
  }, fakeToken);

  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = request.url();
    // Intercept agent listing
    if (url.includes('/api/v1/tenants/test-tenant-id/agents')) {
      if (request.method() === 'POST') {
        request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, agent: { id: 'agent-123', name: 'Local Tester', status: 'ACTIVE', archetype: 'Research', llm_model: 'llama3.2', llm_provider: 'ollama' } }) });
      } else {
        request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, agents: [{ id: 'agent-123', name: 'Local Tester', status: 'ACTIVE', archetype: 'Research', llm_model: 'llama3.2', llm_provider: 'ollama' }] }) });
      }
    } 
    // Intercept settings for LLM Providers
    else if (url.includes('/api/v1/tenants/test-tenant-id/settings')) {
      request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: 'test-tenant-id', name: 'Acme', llm_config: { providers: { ollama: { baseUrl: 'http://localhost:11434', model: 'llama3.2' } } } } }) });
    }
    else if (url.includes('/api/v1/')) {
      request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) });
    } else {
      request.continue();
    }
  });

  console.log("2. Navigating to Agents page...");
  await page.goto('http://localhost:3000/dashboard/agents', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1000));
  
  // It should render the mock agent! Let's click it to open the chat/execution interface.
  console.log("3. Opening Agent detail page...");
  await page.goto('http://localhost:3000/dashboard/agents/agent-123', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 15000));

  console.log("4. Taking screenshot of Agent Interface...");
  await page.screenshot({ path: 'agent_ui_test.png' });
  
  await browser.close();
}

run().catch(console.error);
