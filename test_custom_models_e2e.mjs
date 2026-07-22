import puppeteer from 'puppeteer';

async function run() {
  console.log("1. Launching browser...");
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  
  // Navigate to root to set localStorage
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
  
  // Inject mock session!
  console.log("2. Injecting mock session...");
  await page.evaluate(() => {
    const fakeToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiZXhwIjozMzg4NDQwMDAwfQ.invalid-signature";
    const fakeUser = { id: 'test-user-id', email: 'test@test.com', name: 'Test User' };
    const fakeTenant = { id: 'test-tenant-id', name: 'Test Org', slug: 'test-org', status: 'ACTIVE' };
    
    localStorage.setItem('kuvalam_access_token', fakeToken);
    localStorage.setItem('kuvalam_refresh_token', fakeToken);
    localStorage.setItem('kuvalam_user', JSON.stringify(fakeUser));
    localStorage.setItem('kuvalam_tenant', JSON.stringify(fakeTenant));
    localStorage.setItem('kuvalam_tenants', JSON.stringify([fakeTenant]));
    localStorage.setItem('kuvalam_tenant_id', fakeTenant.id);
  });

  console.log("3. Navigating to Settings...");
  await page.goto('http://localhost:3000/dashboard/settings', { waitUntil: 'networkidle2' });
  
  // We need to intercept the API call to /tenants/test-tenant-id/settings because our token is fake and it will 401!
  console.log("Setting up request interception to mock API responses...");
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().includes('/api/v1/tenants/test-tenant-id/settings')) {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { id: 'test-tenant-id', name: 'Test Org', llm_config: {} } })
      });
    } else if (request.url().includes('/api/v1/tenants/test-tenant-id/custom-models')) {
      if (request.method() === 'POST') {
        request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, customModel: { id: 'cm-123', status: 'PENDING', model_name: 'test-model-v1', data_source: 'file', dataset_path: '/tmp/test.txt', base_model_path: 'llama3.2', created_at: new Date().toISOString() } })
        });
      } else {
        request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, customModels: [] })
        });
      }
    } else {
      request.continue();
    }
  });

  console.log("4. Clicking Custom Models tab...");
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.tab-bar-item'));
    const cmTab = tabs.find(t => t.textContent.includes('Custom Models'));
    if (cmTab) cmTab.click();
  });
  await new Promise(r => setTimeout(r, 1000));
  
  console.log("5. Submitting Custom Model form...");
  await page.type('input[placeholder="e.g. acme-legal-v1"]', 'test-model-v1');
  await page.type('input[placeholder="e.g. llama3.2"]', 'llama3.2'); 
  await page.type('input[placeholder="/Users/PaulJoseph/Downloads/docs"]', '/Users/PaulJoseph/test.txt');
  
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]');
    if (btn) btn.click();
  });

  await new Promise(r => setTimeout(r, 3000));
  console.log("6. Taking final screenshot...");
  await page.screenshot({ path: 'custom_model_test.png' });
  
  await browser.close();
  console.log("Done! Check custom_model_test.png");
}

run().catch(console.error);
