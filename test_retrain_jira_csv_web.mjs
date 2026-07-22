import puppeteer from 'puppeteer';

async function run() {
  console.log("1. Launching browser for Jira CSV Retraining test...");
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

  console.log("4. Filling form to retrain model with jira.csv dataset...");
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
    if (nameInput) setReactValue(nameInput, 'flux-jira-model');

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

    // Select Local Document source
    const dsSelect = selects.find(s => Array.from(s.options).some(o => o.value === 'file'));
    if (dsSelect) {
      dsSelect.value = 'file';
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
    const pathInput = inputs.find(i => i.placeholder && i.placeholder.includes('company_handbook'));
    if (pathInput) setReactValue(pathInput, '/Users/PaulJoseph/Downloads/jira/jira.csv');
  });

  await new Promise(r => setTimeout(r, 500));
  console.log("5. Capturing Jira CSV Retraining Form Filled screenshot...");
  await page.screenshot({ path: 'jira_csv_form_filled.png' });

  console.log("6. Submitting Jira CSV fine-tuning job...");
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

  console.log("7. Capturing auto-opened live stream log drawer screenshot...");
  await page.screenshot({ path: 'jira_csv_live_logs_open.png' });

  await browser.close();
  console.log("Jira CSV Retraining web test completed successfully!");
}

run().catch(console.error);
