// apps/browser-agent/server.js — Lightweight browser controller for Kuvalam agents
// Called by the main API server when an agent uses the browser_use tool.
// Exposes a single POST /action endpoint that accepts: action, url, selector, text, query

import express from 'express'
import { chromium } from 'playwright'

const PORT = process.env.PORT || 9223
const app = express()
app.use(express.json({ limit: '1mb' }))

// ─── Browser lifecycle ─────────────────────────────────────────────────────
// Keep one persistent browser instance to preserve cookies/sessions across calls
let browser = null
let context = null
let page = null
let launchCount = 0

async function ensureBrowser() {
  const needsNew = !browser || !browser.isConnected()
  // Also check if page/context are still usable
  if (!needsNew && page) {
    try {
      // Quick health check — if this throws, the page is dead
      await page.evaluate(() => document.title)
    } catch {
      console.log('[browser-agent] Page disconnected, recreating...')
      // Clean up silently, then recreate
      try { await context?.close() } catch {}
      try { await browser?.close() } catch {}
      browser = null; context = null; page = null
    }
  }

  if (!browser || !browser.isConnected()) {
    launchCount++
    console.log(`[browser-agent] Launching browser #${launchCount}...`)
    try {
      browser = await chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized']
      })
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      })
      page = await context.newPage()
      // Handle browser being closed externally (e.g. user closes window)
      browser.on('disconnected', () => {
        console.log('[browser-agent] Browser disconnected externally, will recreate on next call')
        browser = null; context = null; page = null
      })
      console.log(`[browser-agent] Browser #${launchCount} ready.`)
    } catch (err) {
      console.error(`[browser-agent] Launch failed: ${err.message}`)
      browser = null; context = null; page = null
      throw err
    }
  }
  return page
}

// ─── Action handlers ───────────────────────────────────────────────────────

async function handleAction(action, input) {
  let p
  try {
    p = await ensureBrowser()
  } catch (err) {
    return { success: false, error: `Browser launch failed: ${err.message}` }
  }

  switch (action) {
    case 'navigate': {
      if (!input.url) return { success: false, error: 'url is required for navigate action' }
      // Auto-add https:// if missing
      let url = input.url
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      const title = await p.title()
      const currentUrl = p.url()
      return { success: true, data: { title, url: currentUrl, status: 'loaded' } }
    }

    case 'click': {
      if (!input.selector) return { success: false, error: 'selector is required for click action' }
      // Wait for element to be visible before clicking
      await p.waitForSelector(input.selector, { timeout: 10000 })
      await p.click(input.selector)
      return { success: true, data: { clicked: input.selector } }
    }

    case 'type': {
      if (!input.selector) return { success: false, error: 'selector is required for type action' }
      if (input.text === undefined) return { success: false, error: 'text is required for type action' }
      await p.waitForSelector(input.selector, { timeout: 10000 })
      await p.fill(input.selector, '')  // clear first
      await p.type(input.selector, input.text, { delay: 20 })
      return { success: true, data: { typed: input.text, into: input.selector } }
    }

    case 'extract': {
      // If a URL is provided, navigate there first
      if (input.url) {
        let url = input.url
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      }
      if (input.selector) {
        await p.waitForSelector(input.selector, { timeout: 10000 })
        const texts = await p.$$eval(input.selector, els => els.map(el => el.textContent.trim()).filter(Boolean))
        return { success: true, data: { count: texts.length, items: texts.slice(0, 50) } }
      }
      // No specific selector — extract visible page text
      const bodyText = await p.evaluate(() => {
        // Remove scripts, styles, and hidden elements
        const clone = document.body.cloneNode(true)
        clone.querySelectorAll('script, style, noscript, [aria-hidden="true"], .hidden, svg').forEach(el => el.remove())
        return clone.innerText.trim().slice(0, 5000)
      })
      const title = await p.title()
      const currentUrl = p.url()
      return { success: true, data: { title, url: currentUrl, text: bodyText } }
    }

    case 'screenshot': {
      const screenshot = await p.screenshot({ type: 'png', fullPage: false })
      const base64 = screenshot.toString('base64')
      return { success: true, data: { screenshot: `data:image/png;base64,${base64}` } }
    }

    case 'scroll': {
      await p.evaluate(() => window.scrollBy(0, window.innerHeight))
      return { success: true, data: { scrolled: true } }
    }

    default:
      return { success: false, error: `Unknown action: ${action}. Supported: navigate, click, type, extract, screenshot, scroll` }
  }
}

// ─── HTTP endpoint ─────────────────────────────────────────────────────────

app.post('/action', async (req, res) => {
  const { action, ...input } = req.body
  if (!action) return res.status(400).json({ success: false, error: 'action is required' })

  try {
    const result = await handleAction(action, input)
    // If handleAction threw because the page died mid-action, retry once
    res.json(result)
  } catch (err) {
    const msg = err.message || ''
    console.error(`[browser-agent] Error on ${action}: ${msg}`)
    // If the error is a browser/page disconnection, try to reset and retry once
    if (/target.*closed|browser.*closed|page.*closed|context.*closed|session.*deleted/i.test(msg)) {
      console.log('[browser-agent] Detected disconnection, resetting and retrying once...')
      try { await context?.close() } catch {}
      try { await browser?.close() } catch {}
      browser = null; context = null; page = null
      try {
        const result = await handleAction(action, input)
        return res.json(result)
      } catch (retryErr) {
        console.error(`[browser-agent] Retry also failed: ${retryErr.message}`)
        return res.json({ success: false, error: `Browser error (retry failed): ${retryErr.message}` })
      }
    }
    res.json({ success: false, error: msg })
  }
})

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', browser: browser?.isConnected() ? 'connected' : 'idle' })
})

// ─── Start ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[browser-agent] Listening on port ${PORT}`)
  console.log(`[browser-agent] POST /action — { action, url?, selector?, text?, query? }`)
})

// Graceful shutdown
process.on('SIGTERM', async () => {
  if (browser) await browser.close()
  process.exit(0)
})
process.on('SIGINT', async () => {
  if (browser) await browser.close()
  process.exit(0)
})
