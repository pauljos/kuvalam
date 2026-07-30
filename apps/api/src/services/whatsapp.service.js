// apps/api/src/services/whatsapp.service.js
// WhatsApp Cloud API integration — live conversational agents over WhatsApp
//
// Handles:
//   1. Webhook verification (GET with hub.mode / hub.verify_token / hub.challenge)
//   2. Inbound message processing (POST webhook from Meta)
//   3. Outbound message sending (POST to Meta's Messages API)
//   4. Session management (create, load, update agent conversation state)
//
// Meta Cloud API reference: https://developers.facebook.com/docs/whatsapp/cloud-api

import { createHmac, timingSafeEqual } from 'crypto'
import { query } from '../db/pool.js'
import { decryptCredentials } from './crypto.service.js'
import { enqueueTask } from './queue.service.js'

const WHATSAPP_API_BASE = 'https://graph.facebook.com/v21.0'

// ── Webhook Verification (GET) ────────────────────────────────────────────
// Meta requires a GET handler that echoes back hub.challenge when the
// verify_token matches. Called when configuring the webhook in Meta's dashboard.
export async function verifyWebhook({ mode, token, challenge, tenantId }) {
  if (mode !== 'subscribe') {
    return { verified: false, error: 'Invalid hub.mode — expected "subscribe"' }
  }
  if (!tenantId) {
    return { verified: false, error: 'Tenant not identified' }
  }

  // Find matching WhatsApp connector for this tenant
  const { rows } = await query(
    `SELECT id, config FROM tool_connections
     WHERE tenant_id = $1 AND tool_id = 'whatsapp' AND status = 'ACTIVE'
     LIMIT 1`,
    [tenantId]
  )

  if (rows.length === 0) {
    return { verified: false, error: 'No active WhatsApp connector for this tenant' }
  }

  const cfg = decryptCredentials(rows[0].config || {})
  const expected = cfg.verifyToken || cfg.verify_token

  if (!expected) {
    return { verified: false, error: 'WhatsApp connector has no verify_token configured' }
  }

  if (token !== expected) {
    return { verified: false, error: 'verify_token mismatch' }
  }

  return { verified: true, challenge: parseInt(challenge) || challenge }
}

// ── Webhook Payload Processing (POST) ─────────────────────────────────────
// Meta sends a JSON payload with `entry[].changes[].value` containing messages.
// We validate the X-Hub-Signature-256 header, then process each message.
export async function processWebhook({ body, signature, tenantId, rawBody }) {
  // --- 1. Signature verification ---
  const { rows: [conn] } = await query(
    `SELECT id, config FROM tool_connections
     WHERE tenant_id = $1 AND tool_id = 'whatsapp' AND status = 'ACTIVE'
     LIMIT 1`,
    [tenantId]
  )
  if (!conn) {
    return { success: false, error: 'No active WhatsApp connector for this tenant' }
  }

  const cfg = decryptCredentials(conn.config || {})
  const appSecret = cfg.webhookSecret || cfg.appSecret || cfg.app_secret

  if (appSecret && signature) {
    const expectedSig = createHmac('sha256', appSecret)
      .update(rawBody || JSON.stringify(body))
      .digest('hex')
    const actualSig = signature.replace('sha256=', '')

    try {
      const expectedBuf = Buffer.from(expectedSig, 'hex')
      const actualBuf = Buffer.from(actualSig, 'hex')
      if (expectedBuf.length !== actualBuf.length ||
          !timingSafeEqual(expectedBuf, actualBuf)) {
        return { success: false, error: 'Invalid webhook signature' }
      }
    } catch {
      return { success: false, error: 'Signature verification failed' }
    }
  }

  // --- 2. Extract messages ---
  const results = []
  const entries = body?.entry || []

  for (const entry of entries) {
    const changes = entry?.changes || []
    for (const change of changes) {
      const value = change?.value || {}
      const messages = value?.messages || []
      const contacts = value?.contacts || []
      const metadata = value?.metadata || {}
      const phoneNumberId = metadata?.phone_number_id

      // Ignore status updates (sent/delivered/read receipts)
      const statuses = value?.statuses || []
      for (const status of statuses) {
        results.push({ type: 'status', status: status.status, waMessageId: status.id })
      }

      for (const msg of messages) {
        // Dedup: check if we already processed this message ID
        const waId = msg.id
        if (waId) {
          const { rows: [existing] } = await query(
            `SELECT id FROM whatsapp_messages WHERE wa_message_id = $1 LIMIT 1`,
            [waId]
          )
          if (existing) {
            results.push({ type: 'duplicate', waMessageId: waId, skipped: true })
            continue
          }
        }

        // Extract text content
        let content = ''
        let contentType = msg.type || 'text'
        if (contentType === 'text') {
          content = msg.text?.body || ''
        } else if (contentType === 'interactive') {
          const interactive = msg.interactive || {}
          if (interactive.type === 'button_reply') {
            content = interactive.button_reply?.title || interactive.button_reply?.id || ''
          } else if (interactive.type === 'list_reply') {
            content = interactive.list_reply?.title || interactive.list_reply?.id || ''
          } else {
            content = JSON.stringify(interactive)
          }
        } else if (contentType === 'image') {
          content = `[Image: ${msg.image?.caption || 'no caption'}]`
        } else if (contentType === 'audio') {
          content = `[Audio message]`
        } else if (contentType === 'location') {
          const loc = msg.location || {}
          content = `[Location: ${loc.latitude}, ${loc.longitude} - ${loc.name || loc.address || ''}]`
        } else if (contentType === 'document') {
          content = `[Document: ${msg.document?.filename || 'unnamed'}]`
        } else {
          content = `[${contentType} message]`
        }

        if (!content) continue

        // Find the sender's phone number
        const from = msg.from
        const contact = contacts.find(c => c.wa_id === from)
        const displayName = contact?.profile?.name || from

        // --- 3. Resolve session ---
        const session = await resolveSession(tenantId, from, displayName)

        // --- 4. Save inbound message ---
        await query(
          `INSERT INTO whatsapp_messages (session_id, tenant_id, direction, wa_message_id, content, content_type, metadata)
           VALUES ($1, $2, 'inbound', $3, $4, $5, $6)`,
          [session.id, tenantId, waId, content, contentType,
           JSON.stringify({ from, displayName, phoneNumberId })]
        )

        // --- 5. Enqueue processing job ---
        const job = await enqueueWhatsAppMessage({
          tenantId,
          agentId: session.agent_id,
          sessionId: session.id,
          phoneNumber: from,
          content,
          contentType,
          displayName,
        })

        results.push({
          type: 'message',
          waMessageId: waId,
          sessionId: session.id,
          agentId: session.agent_id,
          jobId: job?.id || null,
        })
      }
    }
  }

  return { success: true, results }
}

// ── Session Resolution ────────────────────────────────────────────────────
// Find or create a WhatsApp session for a given phone number.
// If no session exists, assign it to the tenant's default WhatsApp agent.
async function resolveSession(tenantId, phoneNumber, displayName) {
  // Check existing session
  const { rows: [existing] } = await query(
    `SELECT * FROM whatsapp_sessions
     WHERE tenant_id = $1 AND phone_number = $2 AND is_active = true
     LIMIT 1`,
    [tenantId, phoneNumber]
  )
  if (existing) return existing

  // Find default WhatsApp agent for this tenant
  const { rows: [agent] } = await query(
    `SELECT a.id FROM agents a
     JOIN agent_tool_scopes ats ON ats.agent_id = a.id AND ats.scope_type = 'connector'
     JOIN tool_connections tc ON ats.connector_id = tc.id
     WHERE a.tenant_id = $1 AND a.status = 'ACTIVE'
       AND tc.tool_id = 'whatsapp' AND tc.status = 'ACTIVE'
     ORDER BY a.created_at ASC
     LIMIT 1`,
    [tenantId]
  )

  if (!agent) {
    throw new Error(`No active agent with WhatsApp connector for tenant ${tenantId}`)
  }

  // Create new session
  const { rows: [session] } = await query(
    `INSERT INTO whatsapp_sessions (tenant_id, agent_id, phone_number, display_name, session_state)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [tenantId, agent.id, phoneNumber, displayName, JSON.stringify({
      conversationStarted: new Date().toISOString(),
      messageCount: 0,
    })]
  )
  return session
}

// ── Outbound Message Sending ──────────────────────────────────────────────
// Sends a text message via Meta's WhatsApp Cloud API.
export async function sendMessage({ tenantId, to, text, previewUrl = false }) {
  const { rows: [conn] } = await query(
    `SELECT id, config FROM tool_connections
     WHERE tenant_id = $1 AND tool_id = 'whatsapp' AND status = 'ACTIVE'
     LIMIT 1`,
    [tenantId]
  )
  if (!conn) {
    return { success: false, error: 'No active WhatsApp connector for this tenant' }
  }

  const cfg = decryptCredentials(conn.config || {})
  const phoneNumberId = cfg.phoneNumberId || cfg.phone_number_id
  const accessToken = cfg.accessToken || cfg.access_token

  if (!phoneNumberId || !accessToken) {
    return { success: false, error: 'WhatsApp connector missing phoneNumberId or accessToken' }
  }

  const url = `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: {
      preview_url: previewUrl,
      body: text,
    },
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const data = await response.json()
  if (!response.ok) {
    return { success: false, error: data.error?.message || `HTTP ${response.status}`, details: data.error }
  }

  return { success: true, waMessageId: data.messages?.[0]?.id }
}

// ── Interactive Message Sending ───────────────────────────────────────────
// Sends a message with interactive buttons or list options.
export async function sendInteractive({ tenantId, to, body, buttons, header, footer }) {
  const { rows: [conn] } = await query(
    `SELECT id, config FROM tool_connections
     WHERE tenant_id = $1 AND tool_id = 'whatsapp' AND status = 'ACTIVE'
     LIMIT 1`,
    [tenantId]
  )
  if (!conn) {
    return { success: false, error: 'No active WhatsApp connector' }
  }

  const cfg = decryptCredentials(conn.config || {})
  const phoneNumberId = cfg.phoneNumberId || cfg.phone_number_id
  const accessToken = cfg.accessToken || cfg.access_token

  if (!phoneNumberId || !accessToken) {
    return { success: false, error: 'WhatsApp connector missing credentials' }
  }

  const url = `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: {
        buttons: (buttons || []).slice(0, 3).map(b =>
          typeof b === 'string'
            ? { type: 'reply', reply: { id: b.toLowerCase().replace(/\s+/g, '_'), title: b.slice(0, 20) } }
            : b
        ),
      },
    },
  }
  if (header) payload.interactive.header = { type: 'text', text: header }
  if (footer) payload.interactive.footer = { text: footer }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const data = await response.json()
  if (!response.ok) {
    return { success: false, error: data.error?.message || `HTTP ${response.status}` }
  }

  return { success: true, waMessageId: data.messages?.[0]?.id }
}

// ── Mark message as read ──────────────────────────────────────────────────
export async function markRead({ tenantId, messageId }) {
  const { rows: [conn] } = await query(
    `SELECT id, config FROM tool_connections
     WHERE tenant_id = $1 AND tool_id = 'whatsapp' AND status = 'ACTIVE'
     LIMIT 1`,
    [tenantId]
  )
  if (!conn) return { success: false }

  const cfg = decryptCredentials(conn.config || {})
  const phoneNumberId = cfg.phoneNumberId || cfg.phone_number_id
  const accessToken = cfg.accessToken || cfg.access_token

  const url = `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`
  const body = { messaging_product: 'whatsapp', status: 'read', message_id: messageId }

  await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  return { success: true }
}

// ── Session Management ────────────────────────────────────────────────────
export async function getSession(sessionId, tenantId) {
  const { rows } = await query(
    `SELECT * FROM whatsapp_sessions WHERE id = $1 AND tenant_id = $2`,
    [sessionId, tenantId]
  )
  return rows[0] || null
}

export async function getSessionHistory(sessionId, { limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT * FROM whatsapp_messages
     WHERE session_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [sessionId, limit]
  )
  return rows
}

export async function deactivateSession(sessionId, tenantId) {
  await query(
    `UPDATE whatsapp_sessions SET is_active = false, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2`,
    [sessionId, tenantId]
  )
}

// ── Message Processing (called by BullMQ worker) ──────────────────────────
// This is the live conversational execution mode — lighter than full task execution.
// Loads session history, calls the agent's LLM, and sends the response.
export async function processIncomingMessage(job) {
  const { tenantId, agentId, sessionId, phoneNumber, content, displayName } = job.data

  // Load session and history
  const session = await getSession(sessionId, tenantId)
  if (!session) {
    console.warn(`[WhatsApp] Session ${sessionId} not found — skipping`)
    return { skipped: true, reason: 'Session not found' }
  }

  const history = await getSessionHistory(sessionId, { limit: 50 })

  // Build messages array for LLM
  const systemPrompt = buildWhatsAppSystemPrompt(session, history)
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-20).map(m => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.content,
    })),
    { role: 'user', content },
  ]

  // Call LLM
  try {
    const { complete } = await import('./llm.service.js')
    const { rows: [agent] } = await query(
      `SELECT * FROM agents WHERE id = $1 AND tenant_id = $2`,
      [agentId, tenantId]
    )
    if (!agent) throw new Error('Agent not found')

    // Resolve database connection for agent tools
    const dbConnectionString = await resolveDbConnection(tenantId, agentId)

    // Build tool definitions (DB tools + WhatsApp send)
    const tools = [
      {
        name: 'whatsapp__send_message',
        description: 'Send a WhatsApp text message to the current conversation. Use this to reply to the user.',
        inputSchema: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', description: 'The message text to send to the user via WhatsApp' },
          },
        },
      },
    ]

    // Add DB tools if connected
    if (dbConnectionString) {
      tools.push(
        { name: 'listTables', description: 'List all database tables', inputSchema: { type: 'object', properties: {} } },
        { name: 'describeTable', description: 'Describe a table\'s columns and foreign keys', inputSchema: { type: 'object', required: ['table'], properties: { table: { type: 'string' }, schema: { type: 'string' } } } },
        { name: 'runQuery', description: 'Run a SELECT SQL query', inputSchema: { type: 'object', required: ['sql'], properties: { sql: { type: 'string' } } } }
      )
    }

    // Execute with tool loop (max 5 iterations)
    const result = await executeConversationalLoop({
      messages,
      tools,
      agent,
      dbConnectionString,
      tenantId,
      phoneNumber,
      sessionId,
    })

    // Save assistant response
    await query(
      `INSERT INTO whatsapp_messages (session_id, tenant_id, direction, content, content_type, metadata)
       VALUES ($1, $2, 'outbound', $3, 'text', $4)`,
      [sessionId, tenantId, result.text,
       JSON.stringify({ toolCalls: result.toolCalls || [] })]
    )

    // Update session state
    const state = session.session_state || {}
    state.messageCount = (state.messageCount || 0) + 1
    state.lastExchange = new Date().toISOString()
    await query(
      `UPDATE whatsapp_sessions SET session_state = $1, updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(state), sessionId]
    )

    return { success: true, response: result.text, toolCalls: result.toolCalls }
  } catch (err) {
    console.error(`[WhatsApp] Failed to process message for session ${sessionId}:`, err)

    // Try to send a fallback error message
    try {
      await sendMessage({ tenantId, to: phoneNumber, text: 'Sorry, I encountered an error processing your message. Please try again.' })
    } catch { /* best effort */ }

    // Save error as outbound
    await query(
      `INSERT INTO whatsapp_messages (session_id, tenant_id, direction, content, content_type, metadata)
       VALUES ($1, $2, 'outbound', $3, 'text', $4)`,
      [sessionId, tenantId, '⚠️ Error processing message', JSON.stringify({ error: err.message })]
    )

    throw err
  }
}

// ── Conversational Execution Loop ─────────────────────────────────────────
async function executeConversationalLoop({ messages, tools, agent, dbConnectionString, tenantId, phoneNumber, sessionId }) {
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

    // Check if the model wants to call a tool
    const toolCall = extractToolCall(response)
    if (!toolCall) {
      // Plain text response — send it
      const text = typeof response === 'string' ? response : response?.content || ''
      if (text.trim()) {
        await sendMessage({ tenantId, to: phoneNumber, text: text.slice(0, 1500) })
      }
      return { text: text || 'I processed your request.', toolCalls: toolCallHistory }
    }

    // Execute the tool
    const toolResult = await executeWhatsAppTool({
      toolName: toolCall.name,
      args: toolCall.arguments || {},
      dbConnectionString,
      tenantId,
      phoneNumber,
      sessionId,
    })

    toolCallHistory.push({ name: toolCall.name, args: toolCall.arguments, result: toolResult })

    // Add tool result to messages and continue
    currentMessages.push(
      { role: 'assistant', content: JSON.stringify({ tool_call: toolCall }) },
      { role: 'user', content: `Tool ${toolCall.name} returned: ${JSON.stringify(toolResult)}` }
    )
  }

  // Max iterations reached — force final response
  const finalResponse = await complete({
    tenantId,
    agentId: agent.id || agent.agent_id,
    model: agent.llm_model,
    provider: agent.llm_provider,
    messages: [
      ...currentMessages,
      { role: 'user', content: 'You have reached the maximum number of tool calls. Please summarize what you found and reply to the user naturally. If tools failed, explain that honestly.' },
    ],
    temperature: 0.7,
  })

  const text = typeof finalResponse === 'string' ? finalResponse : finalResponse?.content || 'I was unable to complete your request.'
  await sendMessage({ tenantId, to: phoneNumber, text: text.slice(0, 1500) })
  return { text, toolCalls: toolCallHistory }
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
    // Try parsing from content string (small models embed tool calls in text)
    const content = typeof response === 'string' ? response : response?.content || ''
    if (content && content.includes('"name"') && (content.includes('"arguments"') || content.includes('"args"'))) {
      // Try to extract a JSON block
      const jsonMatch = content.match(/\{[\s\S]*"name"[\s\S]*"arguments"[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        return {
          name: parsed.name,
          arguments: parsed.arguments || parsed.args || parsed.input || {},
        }
      }
    }
  } catch { /* Not a tool call */ }
  return null
}

// ── Tool Execution ────────────────────────────────────────────────────────
async function executeWhatsAppTool({ toolName, args, dbConnectionString, tenantId, phoneNumber, sessionId }) {
  switch (toolName) {
    case 'whatsapp__send_message': {
      const text = args.text || args.message || args.content || ''
      if (!text) return { success: false, error: 'text is required' }
      return sendMessage({ tenantId, to: phoneNumber, text: text.slice(0, 1500) })
    }

    case 'listTables': {
      if (!dbConnectionString) return { success: false, error: 'No database connected to this agent' }
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
    // Check custom_model_databases first
    const { rows: [db] } = await query(
      `SELECT cmd.db_connection_string FROM custom_model_databases cmd
       JOIN custom_models cm ON cm.id = cmd.model_id
       WHERE cm.tenant_id = $1 AND cm.status = 'COMPLETED'
       LIMIT 1`,
      [tenantId]
    )
    if (db?.db_connection_string) return db.db_connection_string

    // Fall back to connector-scoped DB
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
      const password = cfg.password ? decrypt(cfg.password) : (cfg.password || '')
      const database = cfg.database || 'postgres'
      const ssl = cfg.ssl === 'require' || cfg.ssl === 'true' ? '?sslmode=require' : ''
      return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}${ssl}`
    }
  } catch { /* ignore */ }
  return null
}

// ── System Prompt Builder ─────────────────────────────────────────────────
function buildWhatsAppSystemPrompt(session, history) {
  const userName = session.display_name || 'User'
  return `You are a helpful AI assistant communicating via WhatsApp with ${userName}.

RULES:
1. Keep responses CONCISE — WhatsApp is a messaging app. Prefer short paragraphs.
2. Use *bold* for emphasis and \`code\` for technical terms.
3. You have access to these tools:
   - whatsapp__send_message: Send a text reply to the user
   - listTables: List database tables (if DB is connected)
   - describeTable: See columns of a table
   - runQuery: Run SQL SELECT queries
4. When answering data questions, FIRST check the database using listTables/describeTable/runQuery, THEN reply with real data.
5. NEVER fabricate data. If a query fails, tell the user honestly.
6. If the user sends "hi", "hello", or similar, greet them warmly.
7. Use emoji sparingly for a friendly tone.
8. Format lists with - dashes, not numbers.
9. If you need to show a table, format it clearly with aligned columns.
10. Session started: ${session.created_at}`
}

// ── Queue Enqueue Helper ──────────────────────────────────────────────────
let _whatsAppQueue = null

async function enqueueWhatsAppMessage(data) {
  try {
    const { initQueues } = await import('./queue.service.js')
    if (!_whatsAppQueue) {
      const conn = (await import('./queue.service.js')).getRedisConnection?.()
      if (!conn) return null
      const { Queue } = await import('bullmq')
      _whatsAppQueue = new Queue('whatsapp-messages', {
        connection: conn,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 3600, count: 500 },
          removeOnFail: { age: 86400 },
        },
      })
    }
    return _whatsAppQueue.add('process-message', data)
  } catch (err) {
    console.warn(`[WhatsApp] Cannot enqueue — processing synchronously: ${err.message}`)
    return null
  }
}

export { enqueueWhatsAppMessage, buildWhatsAppSystemPrompt, resolveDbConnection }
