import puppeteer from 'puppeteer';

async function run() {
  console.log("1. Launching browser...");
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  
  console.log("2. Navigating to login...");
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
  
  console.log("3. Logging in as paul@acme.com...");
  await page.type('input[placeholder="you@company.com"]', 'paul@acme.com');
  await page.type('input[placeholder="Min. 8 characters"]', 'password123');
  await page.type('input[placeholder="acme"]', 'acme');
  
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]');
    if (btn) btn.click();
  });
  
  await page.waitForNavigation({ waitUntil: 'networkidle2' });
  
  console.log("4. Navigating to Settings...");
  await page.goto('http://localhost:3000/dashboard/settings', { waitUntil: 'networkidle2' });
  
  console.log("5. Opening Custom Models (Local) tab...");
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.tab-bar-item'));
    const cmTab = tabs.find(t => t.textContent.includes('Custom Models'));
    if (cmTab) cmTab.click();
  });
  await new Promise(r => setTimeout(r, 1000));
  
  console.log("6. Filling training configuration...");
  await page.type('input[placeholder="e.g. acme-legal-v1"]', 'acme-finetuned-llama');
  await page.type('input[placeholder="e.g. unsloth/Llama-3.2-1B-Instruct"]', 'unsloth/Llama-3.2-1B-Instruct');
  await page.type('input[placeholder="e.g. /Users/admin/company_handbook.pdf"]', '/Users/PaulJoseph/pgent/package.json');
  
  console.log("7. Triggering Training Job...");
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]');
    if (btn) btn.click();
  });

  console.log("8. Waiting for backend orchestration to pick it up...");
  await new Promise(r => setTimeout(r, 3000));
  
  console.log("9. Taking screenshot of live UI state!");
  await page.screenshot({ path: 'live_training_ui.png' });
  
  await browser.close();
}

run().catch(console.error);
