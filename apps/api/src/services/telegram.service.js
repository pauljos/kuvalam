// apps/api/src/services/telegram.service.js
// Telegram Bot API integration — live conversational agents over Telegram
//
// Handles:
//   1. Webhook verification (setWebhook on startup or manual)
//   2. Inbound message processing (POST webhook from Telegram)
//   3. Outbound message sending (POST to Telegram Bot API)
//   4. Session management (create, load, update agent conversation state)
//
// Telegram Bot API reference: https://core.telegram.org/bots/api

import { query } from '../db/pool.js'
import { v4 as uuidv4 } from 'uuid'  // available in shared deps

const TELEGRAM_API_BASE = 'https://api.telegram.org'

// ── Set / Remove Webhook ──────────────────────────────────────────────────
// Called on connector verification to tell Telegram where to POST updates.
// URL format: https://<domain>/api/v1/tenants/<tenantId>/telegram/webhook/<secretToken>
export async function setWebhookUrl(token, webhookUrl) {
  const url = `${TELEGRAM_API_BASE}/bot${token}/setWebhook`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      max_connections: 5,
    }),
  })
  const data = await res.json()
  return { ok: data.ok, description: data.description }
}

export async function deleteWebhook(token) {
  const url = `${TELEGRAM_API_BASE}/bot${token}/deleteWebhook`
  const res = await fetch(url, { method: 'POST' })
  const data = await res.json()
  return { ok: data.ok, description: data.description }
}

// ── Webhook Payload Processing (POST) ─────────────────────────────────────
// Telegram POSTs Update objects: { update_id, message: {...}, callback_query: {...} }
// We validate via secret token in URL path, then enqueue each message.
export async function processWebhook({ body, tenantId, secretToken }) {
  // --- 1. Token validation ---
  const { rows: [conn] } = await query(
    `SELECT id, config FROM tool_connections
     WHERE tenant_id = $1 AND tool_id = 'telegram' AND status = 'ACTIVE'
     LIMIT 1`,
    [tenantId]
  )
  if (!conn) {
    return { success: false, error: 'No active Telegram connector for this tenant' }
  }

  const { decryptCredentials } = await import('./crypto.service.js')
  const cfg = decryptCredentials(conn.config || {})
  const expectedToken = cfg.webhookSecret || cfg.secret_token || cfg.botToken || cfg.bot_token

  // If a secret token is configured, validate it
  if (expectedToken && secretToken && secretToken !== expectedToken) {
    return { success: false, error: 'Invalid webhook secret token' }
  }

  // --- 2. Extract messages from update ---
  const results = []
  const update = body

  // Telegram sends consecutive update_ids — we track last_processed
  if (update.update_id) {
    const { rows: [last] } = await query(
      `SELECT COALESCE(MAX(telegram_message_id)::bigint, 0) as max_id
       FROM telegram_messages
       WHERE tenant_id = $1 AND direction = 'inbound'`,
      [tenantId]
    )
    // Dedup: skip updates we've already seen (not exact but good enough)
    // We use telegram_message_id below per-message for exact dedup
  }

  // Handle regular messages
  if (update.message) {
    const msg = update.message
    const chat = msg.chat || {}
    const from = msg.from || {}

    const chatId = chat.id
    const telegramMessageId = msg.message_id
    const username = from.username || `${from.first_name || ''} ${from.last_name || ''}`.trim()
    const displayName = `${from.first_name || ''} ${from.last_name || ''}`.trim() || username

    // Dedup by telegram_message_id
    if (telegramMessageId) {
      const { rows: [existing] } = await query(
        `SELECT id FROM telegram_messages WHERE telegram_message_id = $1 AND tenant_id = $2 LIMIT 1`,
        [telegramMessageId, tenantId]
      )
      if (existing) {
        results.push({ type: 'duplicate', telegramMessageId, skipped: true })
        return { success: true, results }
      }
    }

    // Extract content
    let content = ''
    let contentType = 'text'
    if (msg.text) {
      content = msg.text
    } else if (msg.photo) {
      const caption = msg.caption || ''
      content = `[Photo] ${caption}`
      contentType = 'photo'
    } else if (msg.document) {
      content = `[Document: ${msg.document.file_name || 'unnamed'}]`
      contentType = 'document'
    } else if (msg.voice) {
      content = `[Voice message]`
      contentType = 'voice'
    } else if (msg.location) {
      content = `[Location: ${msg.location.latitude}, ${msg.location.longitude}]`
      contentType = 'location'
    } else if (msg.sticker) {
      content = `[Sticker: ${msg.sticker.emoji || ''}]`
      contentType = 'sticker'
    } else {
      content = `[Unsupported message type]`
      contentType = 'unknown'
    }

    if (!content) {
      results.push({ type: 'empty', telegramMessageId })
      return { success: true, results }
    }

    // Handle Telegram slash commands immediately (no agent LLM needed)
    if (content.startsWith('/')) {
      const [cmdRaw, ...cmdArgs] = content.split(/\s+/)
      const cmd = cmdRaw.toLowerCase()
      let replyText = null

      if (cmd === '/start') {
        replyText = `👋 Hello! I'm an AI agent ready to help.\n\nSend me a message and I'll respond. Type /help for available commands.`
      } else if (cmd === '/help') {
        replyText = `🤖 *Available Commands:*\n\n/start — Greet the bot\n/help — Show this message\n/reset — Clear this conversation history\n/status — Show agent info\n\nOr just send any message to chat with the AI agent!`
      } else if (cmd === '/reset') {
        // Clear session history
        const session = await resolveSession(tenantId, chatId, displayName, username, chat.type)
        await query(
          `DELETE FROM telegram_messages WHERE session_id = $1 AND tenant_id = $2`,
          [session.id, tenantId]
        )
        await query(
          `UPDATE telegram_sessions SET session_state = $1 WHERE id = $2`,
          [JSON.stringify({}), session.id]
        )
        replyText = `✅ Conversation history cleared. Start fresh!`
      } else if (cmd === '/status') {
        const session = await resolveSession(tenantId, chatId, displayName, username, chat.type)
        const { rows: [agent] } = await query(
          `SELECT name, archetype FROM agents WHERE id = $1`,
          [session.agent_id]
        )
        const { rows: [{ count }] } = await query(
          `SELECT COUNT(*)::int as count FROM telegram_messages WHERE session_id = $1`,
          [session.id]
        )
        replyText = `🤖 *Agent:* ${agent?.name || 'Unknown'}\n*Type:* ${agent?.archetype || 'general'}\n*Messages:* ${count}`
      }

      if (replyText) {
        await sendMessage({ tenantId, chatId, text: replyText, parseMode: 'Markdown' })
        results.push({ type: 'command', cmd, chatId })
        return { success: true, results }
      }
      // Unknown command — fall through to normal agent processing
    }

    // Resolve session
    const session = await resolveSession(tenantId, chatId, displayName, username, chat.type)

    // Save inbound
    await query(
      `INSERT INTO telegram_messages (session_id, tenant_id, direction, telegram_message_id, content, content_type, metadata)
       VALUES ($1, $2, 'inbound', $3, $4, $5, $6)`,
      [session.id, tenantId, telegramMessageId, content, contentType,
       JSON.stringify({ username, displayName, chatType: chat.type })]
    )

    // Enqueue processing
    const job = await enqueueTelegramMessage({
      tenantId,
      agentId: session.agent_id,
      sessionId: session.id,
      chatId,
      content,
      contentType,
      displayName,
    })

    results.push({
      type: 'message',
      telegramMessageId,
      sessionId: session.id,
      agentId: session.agent_id,
      jobId: job?.id || null,
    })
  }

  // Handle callback queries (inline button presses)
  if (update.callback_query) {
    const cq = update.callback_query
    const chatId = cq.message?.chat?.id || cq.from?.id
    const data = cq.data || ''
    const from = cq.from || {}
    const displayName = `${from.first_name || ''} ${from.last_name || ''}`.trim() || from.username || ''

    const session = await resolveSession(tenantId, chatId, displayName, from.username, 'private')
    const content = `[Button: ${data}]`

    await query(
      `INSERT INTO telegram_messages (session_id, tenant_id, direction, telegram_message_id, content, content_type, metadata)
       VALUES ($1, $2, 'inbound', $3, $4, 'callback_query', $5)`,
      [session.id, tenantId, cq.id, content, JSON.stringify({ callbackData: data, displayName })]
    )

    const job = await enqueueTelegramMessage({
      tenantId,
      agentId: session.agent_id,
      sessionId: session.id,
      chatId,
      content,
      contentType: 'callback_query',
      displayName,
    })

    results.push({ type: 'callback_query', callbackId: cq.id, jobId: job?.id || null })
  }

  return { success: true, results }
}

// ── Session Resolution ────────────────────────────────────────────────────
async function resolveSession(tenantId, chatId, displayName, username, chatType) {
  const { rows: [existing] } = await query(
    `SELECT * FROM telegram_sessions
     WHERE tenant_id = $1 AND chat_id = $2 AND is_active = true
     LIMIT 1`,
    [tenantId, chatId]
  )
  if (existing) return existing

  // Find default Telegram agent for this tenant
  const { rows: [agent] } = await query(
    `SELECT a.id FROM agents a
     JOIN agent_tool_scopes ats ON ats.agent_id = a.id AND ats.scope_type = 'connector'
     JOIN tool_connections tc ON ats.connector_id = tc.id
     WHERE a.tenant_id = $1 AND a.status = 'ACTIVE'
       AND tc.tool_id = 'telegram' AND tc.status = 'ACTIVE'
     ORDER BY a.created_at ASC
     LIMIT 1`,
    [tenantId]
  )

  if (!agent) {
    throw new Error(`No active agent with Telegram connector for tenant ${tenantId}`)
  }

  const { rows: [session] } = await query(
    `INSERT INTO telegram_sessions (tenant_id, agent_id, chat_id, username, display_name, chat_type, session_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [tenantId, agent.id, chatId, username, displayName, chatType || 'private',
     JSON.stringify({ conversationStarted: new Date().toISOString(), messageCount: 0 })]
  )
  return session
}

// ── Outbound Message Sending ──────────────────────────────────────────────

// Resolve token from active connector
async function resolveBotToken(tenantId) {
  const { rows: [conn] } = await query(
    `SELECT id, config FROM tool_connections
     WHERE tenant_id = $1 AND tool_id = 'telegram' AND status = 'ACTIVE'
     LIMIT 1`,
    [tenantId]
  )
  if (!conn) throw new Error('No active Telegram connector')
  const { decryptCredentials } = await import('./crypto.service.js')
  const cfg = decryptCredentials(conn.config || {})
  const token = cfg.botToken || cfg.bot_token
  if (!token) throw new Error('Telegram bot token not configured')
  return token
}

// Send plain text
export async function sendMessage({ tenantId, chatId, text, parseMode, replyMarkup }) {
  const token = await resolveBotToken(tenantId)
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`
  const body = {
    chat_id: chatId,
    text: text.slice(0, 4096),
    parse_mode: parseMode || undefined,
    disable_web_page_preview: true,
  }
  if (replyMarkup) body.reply_markup = replyMarkup

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!data.ok) {
    return { success: false, error: data.description || `HTTP ${res.status}`, errorCode: data.error_code }
  }
  return { success: true, telegramMessageId: data.result?.message_id }
}

// Send photo (by URL or file_id)
export async function sendPhoto({ tenantId, chatId, photo, caption, replyMarkup }) {
  const token = await resolveBotToken(tenantId)
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendPhoto`
  const body = {
    chat_id: chatId,
    photo,
    caption: caption?.slice(0, 1024),
    parse_mode: caption ? 'MarkdownV2' : undefined,
  }
  if (replyMarkup) body.reply_markup = replyMarkup

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  return { success: data.ok, telegramMessageId: data.result?.message_id, error: data.description }
}

// Send inline keyboard (buttons)
export async function sendInlineKeyboard({ tenantId, chatId, text, buttons }) {
  const replyMarkup = {
    inline_keyboard: buttons.map(row =>
      row.map(btn => ({
        text: btn.text,
        callback_data: btn.callback_data || btn.text,
      }))
    ),
  }
  return sendMessage({ tenantId, chatId, text, replyMarkup })
}

// Answer callback query (stops loading indicator on button)
export async function answerCallbackQuery({ tenantId, callbackQueryId, text }) {
  const token = await resolveBotToken(tenantId)
  const url = `${TELEGRAM_API_BASE}/bot${token}/answerCallbackQuery`
  const body = { callback_query_id: callbackQueryId, text: text?.slice(0, 200) }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { success: res.ok }
}

// ── Session Management ────────────────────────────────────────────────────
export async function getSession(sessionId, tenantId) {
  const { rows } = await query(
    `SELECT * FROM telegram_sessions WHERE id = $1 AND tenant_id = $2`,
    [sessionId, tenantId]
  )
  return rows[0] || null
}

export async function getSessionHistory(sessionId, { limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT * FROM telegram_messages
     WHERE session_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [sessionId, limit]
  )
  return rows
}

export async function deactivateSession(sessionId, tenantId) {
  await query(
    `UPDATE telegram_sessions SET is_active = false, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2`,
    [sessionId, tenantId]
  )
}

// ── Message Processing (called by BullMQ worker) ──────────────────────────
export async function processIncomingMessage(job) {
  const { tenantId, agentId, sessionId, chatId, content, displayName } = job.data

  const session = await getSession(sessionId, tenantId)
  if (!session) {
    console.warn(`[Telegram] Session ${sessionId} not found — skipping`)
    return { skipped: true, reason: 'Session not found' }
  }

  const history = await getSessionHistory(sessionId, { limit: 50 })

  // Build system prompt
  const systemPrompt = buildTelegramSystemPrompt(session, history)
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-20).map(m => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.content,
    })),
    { role: 'user', content },
  ]

  try {
    const { complete } = await import('./llm.service.js')
    const { rows: [agent] } = await query(
      `SELECT * FROM agents WHERE id = $1 AND tenant_id = $2`,
      [agentId, tenantId]
    )
    if (!agent) throw new Error('Agent not found')

    const dbConnectionString = await resolveDbConnection(tenantId, agentId)

    const tools = [
      {
        name: 'telegram__send_message',
        description: 'Send a Telegram message to the current conversation.',
        inputSchema: {
          type: 'object', required: ['text'],
          properties: {
            text: { type: 'string', description: 'Message text to send (supports MarkdownV2)' },
            parse_mode: { type: 'string', enum: ['MarkdownV2', 'HTML'], description: 'Parse mode' },
          },
        },
      },
    ]

    if (dbConnectionString) {
      tools.push(
        { name: 'listTables', description: 'List all database tables', inputSchema: { type: 'object', properties: {} } },
        { name: 'describeTable', description: 'Describe table columns', inputSchema: { type: 'object', required: ['table'], properties: { table: { type: 'string' }, schema: { type: 'string' } } } },
        { name: 'runQuery', description: 'Run a SELECT SQL query', inputSchema: { type: 'object', required: ['sql'], properties: { sql: { type: 'string' } } } }
      )
    }

    const result = await executeConversationalLoop({
      messages, tools, agent, dbConnectionString, tenantId, chatId, sessionId,
    })

    await query(
      `INSERT INTO telegram_messages (session_id, tenant_id, direction, content, content_type, metadata)
       VALUES ($1, $2, 'outbound', $3, 'text', $4)`,
      [sessionId, tenantId, result.text, JSON.stringify({ toolCalls: result.toolCalls || [] })]
    )

    const state = session.session_state || {}
    state.messageCount = (state.messageCount || 0) + 1
    state.lastExchange = new Date().toISOString()
    await query(
      `UPDATE telegram_sessions SET session_state = $1, updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(state), sessionId]
    )

    return { success: true, response: result.text, toolCalls: result.toolCalls }
  } catch (err) {
    console.error(`[Telegram] Failed to process message for session ${sessionId}:`, err)
    try {
      await sendMessage({ tenantId, chatId, text: '⚠️ Sorry, I encountered an error. Please try again.' })
    } catch { /* best effort */ }
    await query(
      `INSERT INTO telegram_messages (session_id, tenant_id, direction, content, content_type, metadata)
       VALUES ($1, $2, 'outbound', $3, 'text', $4)`,
      [sessionId, tenantId, '⚠️ Error processing message', JSON.stringify({ error: err.message })]
    )
    throw err
  }
}

// ── Conversational Execution Loop ─────────────────────────────────────────
async function executeConversationalLoop({ messages, tools, agent, dbConnectionString, tenantId, chatId, sessionId }) {
  const MAX_ITERATIONS = 5
  const { complete } = await import('./llm.service.js')

  let currentMessages = [...messages]
  const toolCallHistory = []

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await complete({
      tenantId,
      agentId: agent.id || agent.agent_id,
      model: agent.llm_model,
      provider: agent.llm_provider,
      messages: currentMessages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: 0.7,
    })

    const toolCall = extractToolCall(response)
    if (!toolCall) {
      const text = typeof response === 'string' ? response : response?.content || ''
      if (text.trim()) {
        await sendWithRetry({ tenantId, chatId, text: text.slice(0, 4000) })
      }
      return { text: text || 'I processed your request.', toolCalls: toolCallHistory }
    }

    const toolResult = await executeTelegramTool({
      toolName: toolCall.name,
      args: toolCall.arguments || {},
      dbConnectionString,
      tenantId,
      chatId,
      sessionId,
    })

    toolCallHistory.push({ name: toolCall.name, args: toolCall.arguments, result: toolResult })

    currentMessages.push(
      { role: 'assistant', content: JSON.stringify({ tool_call: toolCall }) },
      { role: 'user', content: `Tool ${toolCall.name} returned: ${JSON.stringify(toolResult)}` }
    )
  }

  const finalResponse = await complete({
    tenantId,
    agentId: agent.id || agent.agent_id,
    model: agent.llm_model,
    provider: agent.llm_provider,
    messages: [
      ...currentMessages,
      { role: 'user', content: 'You have reached the maximum number of tool calls. Summarize what you found and reply naturally.' },
    ],
    temperature: 0.7,
  })

  const text = typeof finalResponse === 'string' ? finalResponse : finalResponse?.content || 'I was unable to complete your request.'
  await sendWithRetry({ tenantId, chatId, text: text.slice(0, 4000) })
  return { text, toolCalls: toolCallHistory }
}

// ── Send with retry (handles Telegram rate limits) ────────────────────────
async function sendWithRetry({ tenantId, chatId, text }, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await sendMessage({ tenantId, chatId, text })
    if (result.success) return result
    if (result.errorCode === 429) {
      // Rate limited — wait and retry
      await new Promise(r => setTimeout(r, (attempt + 1) * 1000))
      continue
    }
    return result
  }
  // Last attempt without retry
  return sendMessage({ tenantId, chatId, text: text.slice(0, 500) + '\n\n_(message truncated)_' })
}

// ── Tool Call Extraction ──────────────────────────────────────────────────
function extractToolCall(response) {
  try {
    if (response?.tool_calls?.[0]) {
      const tc = response.tool_calls[0]
      return {
        name: tc.function?.name || tc.name,
        arguments: typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function?.arguments || tc.arguments || {},
      }
    }
    const content = typeof response === 'string' ? response : response?.content || ''
    if (content && content.includes('"name"') && (content.includes('"arguments"') || content.includes('"args"'))) {
      const jsonMatch = content.match(/\{[\s\S]*"name"[\s\S]*"arguments"[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        return { name: parsed.name, arguments: parsed.arguments || parsed.args || parsed.input || {} }
      }
    }
  } catch { /* Not a tool call */ }
  return null
}

// ── Tool Execution ────────────────────────────────────────────────────────
async function executeTelegramTool({ toolName, args, dbConnectionString, tenantId, chatId, sessionId }) {
  switch (toolName) {
    case 'telegram__send_message': {
      const text = args.text || args.message || args.content || ''
      if (!text) return { success: false, error: 'text is required' }
      return sendMessage({ tenantId, chatId, text: text.slice(0, 4000), parseMode: args.parse_mode })
    }

    case 'listTables': {
      if (!dbConnectionString) return { success: false, error: 'No database connected' }
      try {
        const pg = await import('pg').then(m => m.default || m)
        const client = new pg.Client(dbConnectionString)
        await client.connect()
        const { rows } = await client.query(
          `SELECT table_schema, table_name FROM information_schema.tables
           WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
           ORDER BY table_schema, table_name`
        )
        await client.end().catch(() => {})
        return { success: true, tables: rows, count: rows.length }
      } catch (err) {
        return { success: false, error: err.message }
      }
    }

    case 'describeTable': {
      if (!dbConnectionString) return { success: false, error: 'No database connected' }
      if (!args.table) return { success: false, error: 'table is required' }
      try {
        const pg = await import('pg').then(m => m.default || m)
        const client = new pg.Client(dbConnectionString)
        await client.connect()
        const schema = args.schema || 'public'
        const { rows: cols } = await client.query(
          `SELECT column_name, data_type, is_nullable FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
          [schema, args.table]
        )
        await client.end().catch(() => {})
        return { success: true, table: `${schema}.${args.table}`, columns: cols }
      } catch (err) {
        return { success: false, error: err.message }
      }
    }

    case 'runQuery': {
      if (!dbConnectionString) return { success: false, error: 'No database connected' }
      const sql = args.sql || args.query
      if (!sql) return { success: false, error: 'sql is required' }
      const upper = sql.trim().toUpperCase()
      if (!upper.startsWith('SELECT') && !(upper.startsWith('WITH') && upper.includes('SELECT'))) {
        return { success: false, error: 'Only SELECT queries are allowed' }
      }
      try {
        const pg = await import('pg').then(m => m.default || m)
        const client = new pg.Client(dbConnectionString)
        await client.connect()
        let finalSql = sql.trim()
        if (!finalSql.toUpperCase().includes('LIMIT')) finalSql += ' LIMIT 200'
        const { rows, fields } = await client.query(finalSql)
        await client.end().catch(() => {})
        return { success: true, columns: fields.map(f => f.name), row_count: rows.length, rows }
      } catch (err) {
        return { success: false, error: `Query failed: ${err.message}` }
      }
    }

    default:
      return { success: false, error: `Unknown tool: ${toolName}` }
  }
}

// ── DB Connection Resolution ──────────────────────────────────────────────
async function resolveDbConnection(tenantId, agentId) {
  try {
    const { decrypt } = await import('./crypto.service.js')
    const { rows: [db] } = await query(
      `SELECT cmd.db_connection_string FROM custom_model_databases cmd
       JOIN custom_models cm ON cm.id = cmd.model_id
       WHERE cm.tenant_id = $1 AND cm.status = 'COMPLETED'
       LIMIT 1`,
      [tenantId]
    )
    if (db?.db_connection_string) return db.db_connection_string

    const { rows: [conn] } = await query(
      `SELECT tc.config FROM agent_tool_scopes ats
       JOIN tool_connections tc ON ats.connector_id = tc.id
       WHERE ats.agent_id = $1 AND ats.scope_type = 'connector'
         AND tc.tool_id IN ('database', 'postgres') AND tc.status = 'ACTIVE'
       LIMIT 1`,
      [agentId]
    )
    if (conn?.config) {
      const cfg = decryptCredentials(conn.config)
      const host = cfg.host || 'localhost'
      const port = cfg.port || '5432'
      const user = cfg.user || 'postgres'
      const password = cfg.password ? decrypt(cfg.password) : ''
      const database = cfg.database || 'postgres'
      const ssl = cfg.ssl === 'require' || cfg.ssl === 'true' ? '?sslmode=require' : ''
      return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}${ssl}`
    }
  } catch { /* ignore */ }
  return null
}

// ── System Prompt Builder ─────────────────────────────────────────────────
function buildTelegramSystemPrompt(session, history) {
  return `You are a helpful AI assistant communicating via Telegram.
You are connected to ${session.display_name || 'a user'} in a ${session.chat_type || 'private'} chat.
Rules:
- Keep responses concise (Telegram messages work best under 1000 chars)
- Use MarkdownV2 formatting: *bold* _italic_ ~strikethrough~
- You can run SQL queries against the connected database
- Be conversational but professional
- If you need more info, ask follow-up questions`
}

// ── Queue Enqueue Helper ──────────────────────────────────────────────────
async function enqueueTelegramMessage(data) {
  try {
    const { getRedisConnection } = await import('./queue.service.js')
    const redis = getRedisConnection()
    if (!redis) {
      // Fallback: process inline
      setImmediate(() => processIncomingMessage({ data }))
      return { id: 'inline-fallback' }
    }
    const { Queue } = await import('bullmq')
    const q = new Queue('telegram-messages', { connection: redis })
    const job = await q.add(`tg:${data.sessionId}:${Date.now()}`, data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    })
    return job
  } catch {
    // Fallback: process inline
    setImmediate(() => processIncomingMessage({ data }))
    return { id: 'inline-fallback' }
  }
}
