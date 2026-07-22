import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import path from 'path';

async function run() {
  console.log("Launching browser...");
  const browser = await puppeteer.launch({ 
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  
  console.log("Navigating to dashboard...");
  await page.goto('http://localhost:3000/dashboard/settings', { waitUntil: 'networkidle2', timeout: 15000 }).catch(e => console.log("Navigation timeout/error:", e.message));
  
  // Wait a moment for any client-side rendering
  await new Promise(r => setTimeout(r, 2000));
  
  console.log("Taking screenshot...");
  await page.screenshot({ path: 'debug_screen.png' });
  
  await browser.close();
  console.log("Done! Saved to debug_screen.png");
}

run().catch(console.error);
