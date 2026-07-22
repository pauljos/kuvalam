import puppeteer from 'puppeteer';

async function run() {
  console.log("1. Launching browser for Retraining test...");
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

  console.log("4. Clicking '✏️ Edit' on existing model 'flux-db-tested-model' to populate Retrain form...");
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.card, div[style*="border"]'));
    const targetCard = cards.find(c => c.textContent.includes('flux-db-tested-model'));
    if (targetCard) {
      const editBtn = Array.from(targetCard.querySelectorAll('button')).find(b => b.textContent.includes('Edit'));
      if (editBtn) editBtn.click();
    }
  });

  await new Promise(r => setTimeout(r, 1000));

  console.log("5. Updating Data Source to Local Document with Jira CSV path (/Users/PaulJoseph/Downloads/jira/jira.csv)...");
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

    // Select Local Document source
    const selects = Array.from(document.querySelectorAll('select'));
    const dsSelect = selects.find(s => Array.from(s.options).some(o => o.value === 'file'));
    if (dsSelect) {
      dsSelect.value = 'file';
      dsSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  await new Promise(r => setTimeout(r, 500));

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
  console.log("6. Capturing Retrain Form Filled screenshot...");
  await page.screenshot({ path: 'retrain_jira_form_filled.png' });

  console.log("7. Clicking '🔄 Retrain Existing Model' button...");
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const retrainBtn = buttons.find(b => b.textContent.includes('Retrain Existing Model') || b.textContent.includes('Start Fine-Tuning Job'));
    if (retrainBtn) retrainBtn.click();
  });

  await new Promise(r => setTimeout(r, 4000));
  await page.evaluate(() => {
    window.scrollTo({ top: 600, behavior: 'smooth' });
  });
  await new Promise(r => setTimeout(r, 2000));

  console.log("8. Capturing live stream logs showing Jira CSV parsing & retraining...");
  await page.screenshot({ path: 'retrain_jira_live_logs.png' });

  await browser.close();
  console.log("Retraining existing model with Jira CSV dataset complete!");
}

run().catch(console.error);
