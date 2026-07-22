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

  console.log("3. Navigating to Agents page...");
  await page.goto('http://localhost:3000/dashboard/agents', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1500));

  console.log("4. Clicking '+ Create Agent' button...");
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const createBtn = btns.find(b => b.textContent.includes('Create Agent'));
    if (createBtn) createBtn.click();
  });
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: 'flux_agent_1_modal.png' });

  console.log("5. Filling out Create Agent form for FLUX.1 Schnell model...");
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

    const inputs = Array.from(document.querySelectorAll('.modal input'));
    const nameInput = inputs.find(i => i.placeholder && i.placeholder.includes('Contract Compliance'));
    if (nameInput) setReactValue(nameInput, 'Flux Schnell Designer');

    const descInput = inputs.find(i => i.placeholder && i.placeholder.includes('responsibility'));
    if (descInput) setReactValue(descInput, 'Autonomous generative design agent powered by FLUX.1 Schnell Hugging Face fine-tuned model');

    // Provider select
    const selects = Array.from(document.querySelectorAll('.modal select'));
    if (selects[2]) {
      selects[2].value = 'ollama';
      selects[2].dispatchEvent(new Event('change', { bubbles: true }));
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

    // Set model name to flux-schnell-custom
    const inputs = Array.from(document.querySelectorAll('.modal input'));
    const modelInput = inputs.find(i => i.placeholder && i.placeholder.includes('llama3.2'));
    if (modelInput) setReactValue(modelInput, 'flux-schnell-custom');
  });

  await page.screenshot({ path: 'flux_agent_2_form_filled.png' });

  console.log("6. Submitting Create Agent form...");
  await page.evaluate(() => {
    const btn = document.querySelector('.modal form button[type="submit"]');
    if (btn) btn.click();
  });

  await new Promise(r => setTimeout(r, 2500));
  await page.screenshot({ path: 'flux_agent_3_created.png' });

  console.log("7. Activating the Flux Schnell Designer Agent...");
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.card'));
    const fluxCard = cards.find(c => c.textContent.includes('Flux Schnell Designer'));
    if (fluxCard) {
      const actBtn = Array.from(fluxCard.querySelectorAll('button')).find(b => b.textContent.includes('Activate'));
      if (actBtn) actBtn.click();
    }
  });

  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: 'flux_agent_4_activated.png' });

  console.log("8. Opening the Flux Schnell Designer Agent Execution Interface...");
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.card'));
    const fluxCard = cards.find(c => c.textContent.includes('Flux Schnell Designer'));
    if (fluxCard) {
      const runBtn = Array.from(fluxCard.querySelectorAll('a, button')).find(b => b.textContent.includes('Run Task') || b.textContent.includes('Configure'));
      if (runBtn) runBtn.click();
    }
  });

  await new Promise(r => setTimeout(r, 2500));
  await page.screenshot({ path: 'flux_agent_5_detail_page.png' });

  await browser.close();
  console.log("FLUX.1 Schnell Agent web test completed successfully!");
}

run().catch(console.error);
