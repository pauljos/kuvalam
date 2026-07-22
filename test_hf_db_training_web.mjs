import puppeteer from 'puppeteer';

async function run() {
  console.log("1. Launching browser...");
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1200 });

  console.log("2. Logging in...");
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
  await page.type('input[placeholder="you@company.com"]', 'paul@acme.com');
  await page.type('input[placeholder="Min. 8 characters"]', 'password123');
  await page.type('input[placeholder="acme"]', 'acme');
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 2500));

  console.log("3. Navigating to Settings -> Custom Models...");
  await page.goto('http://localhost:3000/dashboard/settings', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1000));
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.tab-bar-item'));
    const cmTab = tabs.find(t => t.textContent.includes('Custom Models'));
    if (cmTab) cmTab.click();
  });
  await new Promise(r => setTimeout(r, 1500));

  console.log("4. Clicking 'Push to Ollama' for flux-cfw-db-model...");
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const pushBtn = buttons.find(b => b.textContent.includes('Push to Ollama') && b.closest('div')?.textContent?.includes('flux-cfw-db-model'));
    if (pushBtn) pushBtn.click();
  });

  await new Promise(r => setTimeout(r, 8000));
  console.log("5. Taking screenshot after pushing DB fine-tuned FLUX model to Ollama...");
  await page.screenshot({ path: 'flux_db_pushed_to_ollama.png' });

  await browser.close();
  console.log("FLUX.1 Schnell + DB Push to Ollama test complete!");
}

run().catch(console.error);
