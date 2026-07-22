import puppeteer from 'puppeteer';

async function run() {
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
  const fakeToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiZXhwIjozMzg4NDQwMDAwfQ.invalid-signature";
  await page.setCookie({ name: 'kuvalam_token', value: fakeToken, domain: 'localhost', path: '/', httpOnly: true });

  await page.evaluate((token) => {
    const fakeUser = { id: 'test-user-id', email: 'test@test.com', name: 'Test User' };
    const fakeTenant = { id: 'test-tenant-id', name: 'Test Org', slug: 'test-org', status: 'ACTIVE' };
    localStorage.setItem('kuvalam_access_token', token);
    localStorage.setItem('kuvalam_user', JSON.stringify(fakeUser));
    localStorage.setItem('kuvalam_tenant', JSON.stringify(fakeTenant));
    localStorage.setItem('kuvalam_tenants', JSON.stringify([fakeTenant]));
    localStorage.setItem('kuvalam_tenant_id', fakeTenant.id);
  }, fakeToken);

  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = request.url();
    if (url.includes('/api/v1/tenants/test-tenant-id/settings')) {
      request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: 'test-tenant-id', name: 'Test Org', llm_config: {} } }) });
    } else if (url.includes('/api/v1/tenants/test-tenant-id/custom-models')) {
      if (request.method() === 'POST') {
        request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, customModel: { id: 'cm-123', status: 'PENDING', model_name: 'test-model-v1', data_source: 'file', dataset_path: '/tmp/test.txt', base_model_path: 'llama3.2', created_at: new Date().toISOString() } }) });
      } else {
        request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, customModels: [] }) });
      }
    } else if (url.includes('/api/v1/tenants/test-tenant-id/members')) {
      request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, members: [] }) });
    } else if (url.includes('/api/v1/')) {
      request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) });
    } else {
      request.continue();
    }
  });

  await page.goto('http://localhost:3000/dashboard/settings', { waitUntil: 'networkidle2' });
  
  console.log("Clicking Custom Models tab...");
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.tab-bar-item'));
    const cmTab = tabs.find(t => t.textContent.includes('Custom Models'));
    if (cmTab) cmTab.click();
  });
  await new Promise(r => setTimeout(r, 1000));
  
  console.log("Filling form...");
  await page.type('input[placeholder="e.g. acme-legal-v1"]', 'test-model-v1');
  await page.evaluate(() => {
    const inputs = document.querySelectorAll('input');
    if (inputs[1]) inputs[1].value = 'llama3.2'; // base model
    if (inputs[2]) inputs[2].value = '/Users/PaulJoseph/test.txt'; // dataset path
  });
  
  console.log("Clicking submit...");
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]');
    if (btn) btn.click();
  });
  
  await new Promise(r => setTimeout(r, 2000));
  console.log("Taking final screenshot...");
  await page.screenshot({ path: 'custom_model_final.png' });
  
  await browser.close();
  console.log("Done!");
}

run().catch(console.error);
