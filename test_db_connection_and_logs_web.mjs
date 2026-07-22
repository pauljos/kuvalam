import puppeteer from 'puppeteer';

async function run() {
  console.log("1. Launching browser for DB Test & Log Stream verification...");
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1200 });

  console.log("2. Performing full UI login as paul@acme.com with tenant acme...");
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

  console.log("4. Filling out form & testing database connection...");
  await page.evaluate(() => {
    const setReactValue = (element, value) => {
      const valueSetter = Object.getOwnPropertyDescriptor(element, 'value').set;
      const prototype = Object.getPrototypeOf(element);
      const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
        prototypeValueSetter.call(element, value);
      } else {
        valueSetter.call(element, value);
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };

    // Click HuggingFace source button
    const buttons = Array.from(document.querySelectorAll('button'));
    const hfBtn = buttons.find(b => b.textContent.includes('HuggingFace'));
    if (hfBtn) hfBtn.click();

    // Target model name
    const inputs = Array.from(document.querySelectorAll('input'));
    const nameInput = inputs.find(i => i.placeholder && i.placeholder.includes('acme-legal'));
    if (nameInput) setReactValue(nameInput, 'flux-db-tested-model');

    // Select FLUX.1 Schnell
    const selects = Array.from(document.querySelectorAll('select'));
    for (const select of selects) {
      const options = Array.from(select.options);
      const fluxOpt = options.find(o => o.value.includes('FLUX.1-schnell') || o.text.includes('FLUX.1 Schnell'));
      if (fluxOpt) {
        select.value = fluxOpt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
    }

    // Select Database Query
    const dsSelect = selects.find(s => Array.from(s.options).some(o => o.value === 'database'));
    if (dsSelect) {
      dsSelect.value = 'database';
      dsSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  await new Promise(r => setTimeout(r, 800));

  await page.evaluate(() => {
    const setReactValue = (element, value) => {
      const valueSetter = Object.getOwnPropertyDescriptor(element, 'value').set;
      const prototype = Object.getPrototypeOf(element);
      const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
        prototypeValueSetter.call(element, value);
      } else {
        valueSetter.call(element, value);
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const inputs = Array.from(document.querySelectorAll('input'));
    const connInput = inputs.find(i => i.placeholder && i.placeholder.includes('postgresql://'));
    if (connInput) setReactValue(connInput, 'postgresql://dbuser1:postgres@localhost:5434/control_framework_db');
  });

  await new Promise(r => setTimeout(r, 500));

  console.log("5. Clicking 'Test DB Connection' button...");
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const testBtn = buttons.find(b => b.textContent.includes('Test DB Connection'));
    if (testBtn) testBtn.click();
  });

  await new Promise(r => setTimeout(r, 2000));
  console.log("6. Capturing DB Connection Test Success screenshot...");
  await page.screenshot({ path: 'db_connection_test_success.png' });

  console.log("7. Submitting fine-tuning job...");
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const submitBtn = buttons.find(b => b.textContent.includes('Start Fine-Tuning Job') || b.textContent.includes('Retrain Existing Model'));
    if (submitBtn) submitBtn.click();
  });

  await new Promise(r => setTimeout(r, 4000));
  await page.evaluate(() => {
    window.scrollTo({ top: 600, behavior: 'smooth' });
  });
  await new Promise(r => setTimeout(r, 2000));

  console.log("8. Capturing auto-opened live log stream screenshot...");
  await page.screenshot({ path: 'db_live_log_stream_open.png' });

  await browser.close();
  console.log("DB Connection Test and Live Log Stream verification complete!");
}

run().catch(console.error);
