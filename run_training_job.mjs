import puppeteer from 'puppeteer';
import fs from 'fs';

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log("Launching browser...");
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1000 });

  try {
    console.log("Navigating to http://localhost:3000...");
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
    await page.screenshot({ path: 'step1_homepage.png' });

    // Login if needed
    const emailInput = await page.$('input[type="email"]');
    if (emailInput) {
      console.log("Login page detected. Logging in...");
      await page.type('input[type="email"]', 'paul@acme.com');
      await page.type('input[type="password"]', 'password123');
      await page.screenshot({ path: 'step2_login_filled.png' });
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: 'networkidle2' });
      await page.screenshot({ path: 'step3_after_login.png' });
    } else {
      console.log("No login page detected.");
    }

    console.log("Navigating to Settings...");
    await page.goto('http://localhost:3000/dashboard/settings', { waitUntil: 'networkidle2' });
    await page.screenshot({ path: 'step4_settings.png' });

    console.log("Looking for Custom Models tab...");
    await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('*'));
      const tab = elements.find(el => 
        el.textContent && 
        (el.textContent.trim() === 'Custom Models' || el.textContent.trim() === 'Custom Models (Local)') && 
        el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE' && 
        (el.onclick || el.classList.contains('tab') || el.classList.contains('cursor-pointer') || el.tagName === 'BUTTON' || el.tagName === 'A')
      );
      if (tab) tab.click();
    });
    await delay(2000);
    await page.screenshot({ path: 'step5_custom_models_tab.png' });

    console.log("Filling out the form...");
    // Target Model Name
    const targetModelInputs = await page.$$('input');
    // Let's just find the inputs by labels or placeholders
    await page.evaluate(() => {
      // Find Target Model Name input
      const labels = Array.from(document.querySelectorAll('label'));
      
      const targetModelLabel = labels.find(l => l.textContent.includes('Target Model Name'));
      if (targetModelLabel && targetModelLabel.htmlFor) {
        document.getElementById(targetModelLabel.htmlFor).value = 'kuvalam-cfw';
        document.getElementById(targetModelLabel.htmlFor).dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        // Fallback placeholder search
        const inputs = Array.from(document.querySelectorAll('input'));
        const input = inputs.find(i => i.placeholder.includes('name') || i.placeholder.includes('kuvalam'));
        if (input) {
          input.value = 'kuvalam-cfw';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });

    // Base Model Source - click Ollama option/button
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, div'));
      const ollamaBtn = btns.find(b => b.textContent.trim() === 'Ollama' || b.textContent.includes('Ollama'));
      if (ollamaBtn) ollamaBtn.click();
    });
    await delay(1000);

    // Select "llama3.2:latest"
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      // Find the select that has llama3.2 option
      for (const select of selects) {
        const options = Array.from(select.options);
        const llamaOpt = options.find(o => o.text.includes('llama3.2:latest') || o.value.includes('llama3.2:latest'));
        if (llamaOpt) {
          select.value = llamaOpt.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
      }
    });
    await delay(500);

    // Training Data Source - select "Database Query"
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const select of selects) {
        const options = Array.from(select.options);
        const dbOpt = options.find(o => o.text.includes('Database Query') || o.text.includes('PostgreSQL'));
        if (dbOpt) {
          select.value = dbOpt.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
      }
    });
    await delay(1000);

    // Connection String
    await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label'));
      const connLabel = labels.find(l => l.textContent.includes('Connection String'));
      if (connLabel && connLabel.htmlFor) {
        document.getElementById(connLabel.htmlFor).value = 'postgresql://dbuser1:postgres@localhost:5432/control_framework_db';
        document.getElementById(connLabel.htmlFor).dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        const inputs = Array.from(document.querySelectorAll('input'));
        const input = inputs.find(i => i.placeholder && i.placeholder.includes('postgresql://'));
        if (input) {
          input.value = 'postgresql://dbuser1:postgres@localhost:5432/control_framework_db';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });
    
    // Ensure SQL query is empty (it should be empty by default but let's clear it just in case)
    await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label'));
      const sqlLabel = labels.find(l => l.textContent.includes('SQL Query'));
      if (sqlLabel && sqlLabel.htmlFor) {
        document.getElementById(sqlLabel.htmlFor).value = '';
        document.getElementById(sqlLabel.htmlFor).dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    await page.screenshot({ path: 'step6_form_filled.png' });

    console.log("Clicking Start Fine-Tuning Job...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const startBtn = btns.find(b => b.textContent.includes('Start Fine-Tuning Job'));
      if (startBtn) startBtn.click();
    });

    await delay(3000);
    await page.screenshot({ path: 'step7_after_start.png' });

    console.log("Finding kuvalam-cfw job card and clicking Live Stream...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      // Find the card containing 'kuvalam-cfw'
      // Or just look for any 'Live Stream' button near 'kuvalam-cfw'
      const streamBtn = btns.find(b => b.textContent.includes('Live Stream') && b.closest('div').textContent.includes('kuvalam-cfw'));
      if (streamBtn) streamBtn.click();
      else {
          // just try to find any live stream button if first attempt failed
          const fallback = btns.find(b => b.textContent.includes('Live Stream'));
          if (fallback) fallback.click();
      }
    });

    await delay(2000);
    await page.screenshot({ path: 'step8_live_stream_opened.png' });

    console.log("Watching log stream for 30 seconds...");
    // We will collect logs continuously or just take screenshots and grab text at the end
    let logs = [];
    for (let i = 0; i < 6; i++) {
      await delay(5000);
      const currentLogs = await page.evaluate(() => {
        // Typically logs are in a pre or a div with a specific class like bg-gray-900 or terminal
        const pre = document.querySelector('pre');
        if (pre) return pre.textContent;
        // Or find a div containing typical log text
        const codeElements = Array.from(document.querySelectorAll('code'));
        if (codeElements.length > 0) return codeElements.map(c => c.textContent).join('\n');
        
        // Return all text in the likely modal/terminal area
        const possibleTerminals = Array.from(document.querySelectorAll('div')).filter(d => 
          window.getComputedStyle(d).backgroundColor === 'rgb(17, 24, 39)' || // bg-gray-900
          d.classList.contains('terminal') ||
          d.id.includes('terminal')
        );
        if (possibleTerminals.length > 0) return possibleTerminals[0].textContent;
        return "";
      });
      logs.push(`--- Snapshot at ${i * 5 + 5}s ---\n${currentLogs}`);
      await page.screenshot({ path: `step9_stream_${i+1}.png` });
    }

    fs.writeFileSync('stream_logs.txt', logs.join('\n\n'));
    console.log("Stream logs saved to stream_logs.txt");

  } catch (err) {
    console.error("Error during execution:", err);
    await page.screenshot({ path: 'error_state.png' });
  } finally {
    await browser.close();
  }
}

run();
