const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  
  // Login via API to set cookie
  console.log("Logging in via API...");
  const authRes = await fetch('http://localhost:3001/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost:3000' },
    body: JSON.stringify({ email: 'test@example.com', password: 'password123', tenantSlug: 'test-org' })
  });
  const tokenCookie = authRes.headers.get('set-cookie')?.split(';')[0];
  
  if (tokenCookie) {
    const [name, value] = tokenCookie.split('=');
    await context.addCookies([{
      name, value, domain: 'localhost', path: '/'
    }]);
    console.log("Auth cookie set.");
  } else {
    console.log("Warning: No token cookie received.");
  }

  const page = await context.newPage();
  console.log("Navigating to dashboard...");
  await page.goto('http://localhost:3000/dashboard');
  
  console.log("Opening Builder Bot...");
  // Wait for the floating button
  await page.waitForSelector('button[aria-label="Open Builder Bot"]', { timeout: 15000 });
  await page.click('button[aria-label="Open Builder Bot"]');
  
  // Wait for the file input to be available inside the panel
  const fileInput = await page.$('input[type="file"]');
  const filePath = path.resolve('/Users/PaulJoseph/.gemini/antigravity-ide/brain/3a861baf-2b79-425c-938d-922793a81212/scratch/Motability_CLAIMS_LSM_MAPPING (1).xlsx');
  console.log("Uploading file...");
  await fileInput.setInputFiles(filePath);
  
  // Wait for preview to appear
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'builder_bot_attachment_styling_2.png' });
  console.log("Saved builder_bot_attachment_styling_2.png");

  // Type message and submit to see loading state
  console.log("Submitting message...");
  await page.fill('input[placeholder*="Ask me to build"]', 'upload test file');
  await page.keyboard.press('Enter');
  
  await page.waitForTimeout(50); // Just enough to trigger the loading state
  await page.screenshot({ path: 'builder_bot_loading_state_2.png' });
  console.log("Saved builder_bot_loading_state_2.png");

  // Now let's check reports
  console.log("Navigating to Reports...");
  await page.goto('http://localhost:3000/dashboard/reports');
  await page.waitForSelector('.report-list-item', { timeout: 10000 }).catch(() => {});
  
  const reportItem = await page.$('.report-list-item');
  if (reportItem) {
    console.log("Clicking first report...");
    await reportItem.click();
    await page.waitForTimeout(1500); // wait for iframe to load
    await page.screenshot({ path: 'medical_chart_sandbox_2.png' });
    console.log("Saved medical_chart_sandbox_2.png");
  } else {
    console.log("No reports found to screenshot.");
  }

  await browser.close();
})();
