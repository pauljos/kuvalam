import puppeteer from 'puppeteer';

async function run() {
  console.log("1. Launching browser...");
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  
  console.log("2. Logging in as paul@acme.com...");
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
  await page.type('input[placeholder="you@company.com"]', 'paul@acme.com');
  await page.type('input[placeholder="Min. 8 characters"]', 'password123');
  await page.type('input[placeholder="acme"]', 'acme');
  
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]');
    if (btn) btn.click();
  });
  
  await page.waitForNavigation({ waitUntil: 'networkidle2' });
  
  console.log("3. Creating a new Local Agent via API...");
  const token = await page.evaluate(() => localStorage.getItem('kuvalam_access_token'));
  const tenantId = await page.evaluate(() => localStorage.getItem('kuvalam_tenant_id'));
  
  const createRes = await fetch(`http://localhost:3001/api/v1/tenants/${tenantId}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ name: 'Local Inference Tester', archetype: 'Research', llm_provider: 'ollama', llm_model: 'llama3.2' })
  });
  
  const createData = await createRes.json();
  const agentId = createData.data?.id || createData.agent?.id || createData.id;
  
  if (!agentId) {
    console.log("Failed to create agent:", createData);
    await browser.close();
    return;
  }
  
  console.log(`4. Opening Agent execution interface (ID: ${agentId})...`);
  await page.goto(`http://localhost:3000/dashboard/agents/${agentId}`, { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 2000));
  
  console.log("5. Submitting test task to local agent...");
  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    const input = inputs.find(i => i.placeholder && (i.placeholder.includes('Test') || i.placeholder.includes('Ask') || i.placeholder.includes('What do you want')));
    if (input) {
      input.value = "List three benefits of local AI inference.";
      input.dispatchEvent(new Event('input', { bubbles: true }));
      
      const buttons = Array.from(document.querySelectorAll('button'));
      const runBtn = buttons.find(b => b.textContent.includes('Run') || b.textContent.includes('Test') || b.textContent.includes('Execute'));
      if (runBtn) runBtn.click();
    } else {
      console.log("Could not find input field!");
    }
  });
  
  console.log("6. Waiting for local LLM to generate a response...");
  await new Promise(r => setTimeout(r, 8000));
  
  console.log("7. Taking screenshot of live UI state!");
  await page.screenshot({ path: 'local_agent_execution_ui.png' });
  
  await browser.close();
}

run().catch(console.error);
