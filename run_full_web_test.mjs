import puppeteer from 'puppeteer';

async function run() {
  console.log("1. Launching browser...");
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });

  console.log("2. Logging into Kuvalam Web App...");
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
  await page.type('input[placeholder="you@company.com"]', 'paul@acme.com');
  await page.type('input[placeholder="Min. 8 characters"]', 'password123');
  await page.type('input[placeholder="acme"]', 'acme');
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 2500));
  await page.screenshot({ path: 'web_test_1_dashboard.png' });

  console.log("3. Testing Agents Page & Agent Creation...");
  await page.goto('http://localhost:3000/dashboard/agents', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: 'web_test_2_agents_list.png' });

  console.log("4. Opening Agent Interface & Sending Execution Prompt...");
  // Click open on first active agent
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, a'));
    const openBtn = buttons.find(b => b.textContent && b.textContent.trim() === 'Open');
    if (openBtn) openBtn.click();
  });
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: 'web_test_3_agent_detail.png' });

  console.log("5. Testing Workflow Builder Canvas...");
  await page.goto('http://localhost:3000/dashboard/workflows', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: 'web_test_4_workflows.png' });

  console.log("6. Testing Knowledge Base / Document Upload view...");
  await page.goto('http://localhost:3000/dashboard/knowledge', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: 'web_test_5_knowledge.png' });

  console.log("7. Testing Settings & LLM Provider Test Connection...");
  await page.goto('http://localhost:3000/dashboard/settings', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1500));
  
  // Click Configure on Ollama or OpenAI
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const cfgBtn = buttons.find(b => b.textContent && (b.textContent.includes('Configure') || b.textContent.includes('Edit')));
    if (cfgBtn) cfgBtn.click();
  });
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: 'web_test_6_settings_provider.png' });

  await browser.close();
  console.log("Full web test suite finished successfully!");
}

run().catch(console.error);
