import puppeteer from 'puppeteer';

(async () => {
  console.log("Launching Chrome...");
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
  });

  try {
    const page = await browser.newPage();
    
    // 1. Navigate to dashboard
    console.log("Navigating to http://localhost:3000/dashboard/settings...");
    await page.goto('http://localhost:3000/dashboard/settings');

    // 2. Handle Login if present
    const loginVisible = await page.$('input[type="email"]').catch(() => null);
    if (loginVisible) {
      console.log("Logging in...");
      await page.type('input[type="email"]', 'paul@acme.com');
      await page.type('input[type="password"]', 'password123');
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'networkidle0' });
    }

    // 3. Go to Custom Models tab
    console.log("Clicking Custom Models tab...");
    // Assuming there's a button or tab with "Custom Models" text
    const tabs = await page.$$('button, a, div[role="tab"]');
    for (const tab of tabs) {
      const text = await page.evaluate(el => el.textContent, tab);
      if (text && text.includes('Custom Models')) {
        await tab.click();
        break;
      }
    }
    await new Promise(r => setTimeout(r, 1000));

    // 4. Fill form
    console.log("Filling form...");
    // Target Model Name
    const targetModelInput = await page.$('input[placeholder*="Model Name"], input[name="targetModelName"]');
    if (targetModelInput) {
      await targetModelInput.type('kuvalam-cfw');
    }

    // Base Model Source
    const sourceButtons = await page.$$('button, div');
    for (const btn of sourceButtons) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text === 'Ollama' || text === 'Ollama (Local)') {
        await btn.click();
        break;
      }
    }

    await new Promise(r => setTimeout(r, 500));

    // Base Model
    const modelDropdown = await page.$('select[name="baseModel"]');
    if (modelDropdown) {
      await page.select('select[name="baseModel"]', 'llama3.2:latest');
    }

    // Training Data Source
    const sourceDropdown = await page.$('select[name="dataSource"]');
    if (sourceDropdown) {
      await page.select('select[name="dataSource"]', 'database');
    }

    await new Promise(r => setTimeout(r, 500));

    // Connection String
    const connInput = await page.$('input[name="dbConnectionString"], input[placeholder*="postgresql://"]');
    if (connInput) {
      await connInput.type('postgresql://dbuser1:postgres@localhost:5432/control_framework_db');
    }

    // 5. Submit form
    console.log("Clicking Start Fine-Tuning Job...");
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text && text.includes('Start Fine-Tuning Job')) {
        await btn.click();
        break;
      }
    }

    // 6. Wait for Live Stream
    console.log("Waiting for job to appear...");
    await new Promise(r => setTimeout(r, 2000));
    const streamButtons = await page.$$('button');
    for (const btn of streamButtons) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text && text.includes('Live Stream')) {
        console.log("Opening Live Stream...");
        await btn.click();
        break;
      }
    }

    // Keep browser open for a bit to watch it
    console.log("Watching live stream... browser will stay open for 15 seconds.");
    await new Promise(r => setTimeout(r, 15000));
    
  } catch (error) {
    console.error("Test error:", error);
  } finally {
    console.log("Closing browser...");
    await browser.close();
  }
})();
