// apps/api/src/services/task.service.js
// Agent task execution loop — Plan → Execute → Synthesise
import { createHmac } from 'crypto'
import { query } from '../db/pool.js'
import { complete, completeStream } from './llm.service.js'
import { searchKnowledge } from './knowledge.service.js'
import { auditLog } from '../utils/audit.js'
import { AppError } from '../utils/errors.js'
import { enqueueTask } from './queue.service.js'
import { decryptCredentials } from './crypto.service.js'
import { getTenantMcpServers, listMcpTools, callMcpTool } from './mcp.service.js'
import { getValidAccessToken } from './oauth.service.js'
import { broadcastTelemetry } from './telemetry.service.js'
import { extractAndStoreMemory, retrieveMemory } from './memory.service.js'
import {
  getConnectorToolDefinitions,
  executeConnectorTool,
  CONNECTOR_TOOL_PREFIXES,
} from './connector-tools.service.js'

/**
 * Sign a short-lived scoped bearer token for outbound A2A delegation calls.
 * The token is a compact HMAC-signed JSON (NOT the master JWT_SECRET). External
 * agents can only replay it for ~5 minutes and it never grants access to Kuvalam.
 */
function signA2ACallToken({ agentId, taskId, agentUrl }) {
  const secret = process.env.A2A_CALL_SECRET || process.env.JWT_SECRET || 'kuvalam-a2a-dev'
  const payload = {
    iss: 'kuvalam',
    sub: `agent:${agentId}`,
    taskId,
    aud: (() => { try { return new URL(agentUrl).host } catch { return null } })(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300 // 5 min
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

export async function dispatchTask({ tenantId, agentId, goal, context = {}, priority = 'MEDIUM', userId, attachments = [] }) {
  // Input validation
  if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
    throw new AppError('MISSING_GOAL', 'Task goal is required and must be a non-empty string', 400)
  }
  if (goal.length > 10_000) {
    throw new AppError('GOAL_TOO_LONG', 'Task goal must be 10,000 characters or fewer', 400)
  }
  // Validate attachments — only allow http/https/data URLs, max 5
  if (!Array.isArray(attachments)) attachments = []
  if (attachments.length > 5) throw new AppError('TOO_MANY_ATTACHMENTS', 'Maximum 5 attachments per task', 400)
  for (const att of attachments) {
    if (att.type === 'image_url' && !/^https:\/\//.test(att.url || '')) {
      throw new AppError('INVALID_ATTACHMENT', 'Image attachments must be publicly accessible https:// URLs', 400)
    }
  }
  const VALID_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH']
  if (!VALID_PRIORITIES.includes(priority)) priority = 'MEDIUM'

  // Verify agent is active
  let agent
  if (agentId) {
    const { rows } = await query(
      `SELECT a.*, t.llm_config FROM agents a
       JOIN tenants t ON t.id = a.tenant_id
       WHERE a.id = $1 AND a.tenant_id = $2 AND a.status = 'ACTIVE'`,
      [agentId, tenantId]
    )
    agent = rows[0]
  }

  // Fallback to active agent if original is not active or not found
  if (!agent) {
    let archetype = null
    if (agentId) {
      const { rows: [orig] } = await query('SELECT archetype FROM agents WHERE id = $1', [agentId])
      archetype = orig?.archetype
    }

    if (archetype) {
      const { rows } = await query(
        `SELECT a.*, t.llm_config FROM agents a
         JOIN tenants t ON t.id = a.tenant_id
         WHERE a.tenant_id = $1 AND a.status = 'ACTIVE' AND a.archetype = $2
         ORDER BY a.created_at ASC`,
        [tenantId, archetype]
      )
      agent = rows[0]
    }

    if (!agent) {
      const { rows } = await query(
        `SELECT a.*, t.llm_config FROM agents a
         JOIN tenants t ON t.id = a.tenant_id
         WHERE a.tenant_id = $1 AND a.status = 'ACTIVE'
         ORDER BY a.created_at ASC`,
        [tenantId]
      )
      agent = rows[0]
    }
  }

  if (!agent) throw new AppError('AGENT_NOT_ACTIVE', 'No active agent found for this tenant', 422)
  agentId = agent.id

  const { rows: [task] } = await query(
    `INSERT INTO agent_tasks (agent_id, tenant_id, goal, context, priority, status, created_by)
     VALUES ($1,$2,$3,$4,$5,'QUEUED',$6) RETURNING *`,
    [agentId, tenantId, goal, { ...context, attachments }, priority, userId]
  )

  await auditLog({ eventType: 'agent.task_queued', tenantId, actorId: agentId, actorType: 'AGENT', resourceType: 'AgentTask', resourceId: task.id, action: 'QUEUE_TASK' })

  // Enqueue via BullMQ (falls back to setImmediate if Redis unavailable)
  await enqueueTask(task, agent, executeTask)

  return { ...task, taskId: task.id }
}

export async function getTask(tenantId, taskId) {
  const { rows: [task] } = await query(
    'SELECT * FROM agent_tasks WHERE id = $1 AND tenant_id = $2',
    [taskId, tenantId]
  )
  if (!task) throw new AppError('TASK_NOT_FOUND', 'Task not found', 404)
  return task
}

export async function listTasks(tenantId, agentId, { status, page = 1, pageSize = 20 } = {}) {
  const conditions = ['tenant_id = $1', 'agent_id = $2']
  const params = [tenantId, agentId]
  if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status) }

  const offset = (page - 1) * pageSize
  const { rows } = await query(
    `SELECT * FROM agent_tasks WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  )
  return rows
}

export async function executeTask(task, agent) {
  const startTime = Date.now()
  const tenantId = agent.tenant_id

  // Mark as running
  await query(`UPDATE agent_tasks SET status = 'RUNNING', started_at = NOW() WHERE id = $1 AND tenant_id = $2`, [task.id, tenantId])
  broadcastTelemetry(tenantId, 'agent.task_started', { taskId: task.id, agentId: agent.id, agentName: agent.name })

  const actions = []
  let totalTokens = { prompt: 0, completion: 0, total: 0 }

  try {
    // 1. Load agent skills as tools
    const { rows: skills } = await query(
      'SELECT * FROM agent_skills WHERE agent_id = $1 AND is_enabled = true',
      [agent.id]
    )

    // 2. Retrieve relevant knowledge
    const knowledgeContext = await retrieveKnowledge(agent, task.goal)

    // 3. Load agent's episodic memory (past similar tasks)
    const episodicContext = await loadEpisodicMemory(agent.id, task.goal)

    // 3b. Load long-term entity memory
    const longTermMemory = await retrieveMemory(agent.id, task.goal)

    // 4. Build system prompt
    const systemPrompt = buildSystemPrompt(agent, skills)

    // 5. Build initial messages
    // 5. Build initial messages — support multimodal (image) attachments
    const userContent = []
    userContent.push({ type: 'text', text: `TASK GOAL: ${task.goal}\n\nCONTEXT: ${JSON.stringify(task.context)}` })

    const imageAttachments = (task.context?.attachments || []).filter(a => a.type === 'image_url' && a.url)
    for (const att of imageAttachments) {
      userContent.push({ type: 'image_url', image_url: { url: att.url, detail: 'high' } })
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...longTermMemory,
      ...episodicContext,
      ...knowledgeContext,
      { role: 'user', content: imageAttachments.length > 0 ? userContent : userContent[0].text }
    ]

    // 6. Planning phase — stream tokens to connected clients
    broadcastTelemetry(tenantId, 'agent.phase', { taskId: task.id, phase: 'planning', label: 'Formulating plan...' })

    let planText = ''
    const plan = await completeStream({
      tenantId: agent.tenant_id,
      agentId: agent.id,
      messages: [...messages, { role: 'user', content: 'First, create a brief step-by-step plan to accomplish this task. List the steps you will take.' }],
      model: agent.llm_model,
      llmConfig: agent.llm_config,
      provider: agent.llm_provider,
      goal: task.goal,
      onToken: (token) => {
        planText += token
        broadcastTelemetry(tenantId, 'agent.token', { taskId: task.id, phase: 'planning', token })
      }
    })
    totalTokens.prompt += plan.usage.prompt
    totalTokens.completion += plan.usage.completion
    totalTokens.total += plan.usage.total

    // Store plan
    await query(`UPDATE agent_tasks SET plan = $1 WHERE id = $2 AND tenant_id = $3`, [{ steps: plan.content }, task.id, tenantId])
    broadcastTelemetry(tenantId, 'agent.plan_ready', { taskId: task.id, plan: plan.content })

    // 7. Execution phase — tool-use loop with streaming
    const execMessages = [
      ...messages,
      { role: 'assistant', content: `My plan: ${plan.content}\n\nNow I will execute this plan step by step.` },
      // Priming turn: explicitly instruct local models to call tools rather than hallucinating
      { role: 'user', content: 'Now execute your plan. You MUST use the available tools to gather real data — do NOT invent or guess any values. Call the appropriate tool(s) now.' }
    ]

    const toolDefinitions = skills.map(s => ({
      name: s.name.replace(/\s+/g, '_').toLowerCase(),
      description: s.description || `Execute the ${s.name} skill`,
      inputSchema: s.config?.inputSchema || { type: 'object', properties: { input: { type: 'string' } } }
    }))

    // Load MCP server tools
    try {
      const mcpServers = await getTenantMcpServers(agent.tenant_id)
      for (const server of mcpServers) {
        const mcpTools = await listMcpTools(server)
        for (const tool of mcpTools) {
          const uniqueName = `mcp__${server.id.replace(/-/g, '_')}__${tool.name}`
          toolDefinitions.push({
            name: uniqueName,
            description: `[MCP: ${server.name}] ${tool.description || ''}`,
            inputSchema: tool.inputSchema || { type: 'object', properties: {} }
          })
        }
      }
    } catch (err) {
      console.error('[MCP] Error fetching tools during task planning:', err.message)
    }

    // Load configured connector tools (Slack, Jira, GitHub, Gmail, Webhook, …)
    // Only ACTIVE connectors surface as tools, so the LLM never plans with a
    // credential that hasn't passed the Test.
    try {
      const connectorDefs = await getConnectorToolDefinitions(agent.tenant_id)
      for (const def of connectorDefs) toolDefinitions.push(def)
    } catch (err) {
      console.error('[Connectors] Error building connector tool definitions:', err.message)
    }

    // Built-in HTTP tool
    toolDefinitions.push({
      name: 'http_request',
      description: 'Make an HTTP request to any URL',
      inputSchema: {
        type: 'object', required: ['url', 'method'],
        properties: {
          url: { type: 'string' }, method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          body: { type: 'object' }, headers: { type: 'object' }
        }
      }
    })

    // A2A — call an external agent by URL
    toolDefinitions.push({
      name: 'a2a_call',
      description: 'Delegate a subtask to another AI agent (internal or external) via the A2A protocol. Use this to collaborate with specialised agents.',
      inputSchema: {
        type: 'object', required: ['agentUrl', 'goal'],
        properties: {
          agentUrl: { type: 'string', description: 'The A2A agent base URL (e.g. https://other-system.com/a2a/agents/xyz)' },
          goal: { type: 'string', description: 'The task goal to delegate' }
        }
      }
    })

    // Browser control tool
    toolDefinitions.push({
      name: 'browser_use',
      description: 'Control a real web browser: navigate to URLs, click elements, fill forms, and extract page content. Use this to interact with websites that have no API.',
      inputSchema: {
        type: 'object', required: ['action'],
        properties: {
          action: { type: 'string', enum: ['navigate', 'click', 'type', 'extract', 'screenshot', 'scroll'] },
          url:      { type: 'string', description: 'URL to navigate to (for navigate action)' },
          selector: { type: 'string', description: 'CSS selector for click/type actions' },
          text:     { type: 'string', description: 'Text to type (for type action)' },
          query:    { type: 'string', description: 'What to extract from the page (for extract action)' }
        }
      }
    })

    let actionCount = 0
    const maxActions = agent.max_actions_per_run || 20
    let continueLoop = true

    while (continueLoop && actionCount < maxActions) {
      broadcastTelemetry(tenantId, 'agent.phase', { taskId: task.id, phase: 'thinking', label: 'Thinking...' })

      const response = await completeStream({
        tenantId: agent.tenant_id,
        agentId: agent.id,
        messages: execMessages,
        tools: toolDefinitions,
        model: agent.llm_model,
        llmConfig: agent.llm_config,
        provider: agent.llm_provider,
        onToken: (token) => {
          broadcastTelemetry(tenantId, 'agent.token', { taskId: task.id, phase: 'thinking', token })
        }
      })

      totalTokens.prompt += response.usage.prompt
      totalTokens.completion += response.usage.completion
      totalTokens.total += response.usage.total

      if (response.finishReason === 'stop' || !response.toolCalls?.length) {
        execMessages.push({ role: 'assistant', content: response.content })
        continueLoop = false
      } else if (response.toolCalls?.length > 0) {
        execMessages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls })

        for (const toolCall of response.toolCalls) {
          actionCount++
          const toolInput = JSON.parse(toolCall.function.arguments || '{}')

          broadcastTelemetry(tenantId, 'agent.tool_call', {
            taskId: task.id,
            actionIdx: actionCount,
            tool: toolCall.function.name,
            input: toolInput
          })

          const toolResult = await executeTool(toolCall.function.name, toolInput, agent, skills)

          broadcastTelemetry(tenantId, 'agent.tool_result', {
            taskId: task.id,
            actionIdx: actionCount,
            tool: toolCall.function.name,
            success: toolResult.success,
            output: toolResult
          })

          actions.push({
            id: toolCall.id,
            skill: toolCall.function.name,
            input: toolInput,
            output: toolResult,
            timestamp: new Date().toISOString()
          })

          await query(`UPDATE agent_tasks SET actions = $1 WHERE id = $2 AND tenant_id = $3`, [JSON.stringify(actions), task.id, tenantId])

          execMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult)
          })
        }
      }
    }

    // 8. Synthesise final result — stream tokens
    broadcastTelemetry(tenantId, 'agent.phase', { taskId: task.id, phase: 'synthesising', label: 'Synthesising results...' })

    const synthesis = await completeStream({
      tenantId: agent.tenant_id,
      agentId: agent.id,
      messages: [...execMessages, { role: 'user', content: 'Please provide a clear, concise summary of what you accomplished and the key results.' }],
      model: agent.llm_model,
      llmConfig: agent.llm_config,
      provider: agent.llm_provider,
      onToken: (token) => {
        broadcastTelemetry(tenantId, 'agent.token', { taskId: task.id, phase: 'synthesising', token })
      }
    })
    totalTokens.total += synthesis.usage.total

    const result = {
      output: synthesis.content,
      confidence: extractConfidence(synthesis.content),
      summary: synthesis.content
    }

    // 9. Save episodic memory
    await saveEpisodicMemory(agent, task, result, actions)

    // 9b. Extract and store long-term entity memory from synthesis
    await extractAndStoreMemory(agent.id, tenantId, task.id, synthesis.content, agent.llm_config, agent.llm_provider)

    // 10. Mark complete
    await query(
      `UPDATE agent_tasks SET status = 'COMPLETED', result = $1, actions = $2, token_usage = $3, completed_at = NOW() WHERE id = $4 AND tenant_id = $5`,
      [result, JSON.stringify(actions), JSON.stringify(totalTokens), task.id, tenantId]
    )

    broadcastTelemetry(tenantId, 'agent.task_completed', {
      taskId: task.id,
      agentId: agent.id,
      confidence: result.confidence,
      tokensUsed: totalTokens.total,
      durationMs: Date.now() - startTime
    })

    await auditLog({
      eventType: 'agent.task_completed', tenantId, actorId: agent.id,
      actorType: 'AGENT', resourceType: 'AgentTask', resourceId: task.id, action: 'COMPLETE_TASK',
      afterState: { status: 'COMPLETED', tokensUsed: totalTokens.total }
    })

  } catch (err) {
    await query(
      `UPDATE agent_tasks SET status = 'FAILED', error = $1, actions = $2, token_usage = $3, completed_at = NOW() WHERE id = $4 AND tenant_id = $5`,
      [err.message, JSON.stringify(actions), JSON.stringify(totalTokens), task.id, tenantId]
    )
    broadcastTelemetry(tenantId, 'agent.task_failed', { taskId: task.id, agentId: agent.id, error: err.message })
    throw err
  }
}

async function retrieveKnowledge(agent, goal) {
  try {
    const { rows: kbLinks } = await query(
      'SELECT knowledge_base_id FROM agent_knowledge_bases WHERE agent_id = $1',
      [agent.id]
    )
    if (kbLinks.length === 0) return []

    const kbIds = kbLinks.map(r => r.knowledge_base_id)
    const chunks = await searchKnowledge({ tenantId: agent.tenant_id, query: goal, knowledgeBaseIds: kbIds, topK: 5 })

    if (chunks.length === 0) return []

    return [{
      role: 'system',
      content: `RELEVANT KNOWLEDGE:\n${chunks.map(c => `[Source: ${c.documentName}]\n${c.content}`).join('\n\n---\n\n')}`
    }]
  } catch {
    return []
  }
}

async function loadEpisodicMemory(agentId, goal) {
  try {
    const { rows } = await query(
      `SELECT goal_summary, outcome, result_summary FROM agent_episodic_memory
       WHERE agent_id = $1 AND outcome = 'SUCCESS'
       ORDER BY created_at DESC LIMIT 3`,
      [agentId]
    )
    if (rows.length === 0) return []

    return [{
      role: 'system',
      content: `PAST EXPERIENCE (similar tasks):\n${rows.map(r => `- Goal: ${r.goal_summary}\n  Result: ${r.result_summary}`).join('\n')}`
    }]
  } catch {
    return []
  }
}

async function saveEpisodicMemory(agent, task, result, actions) {
  try {
    await query(
      `INSERT INTO agent_episodic_memory (agent_id, tenant_id, task_id, task_type, goal_summary, outcome, key_actions, result_summary)
       VALUES ($1,$2,$3,$4,$5,'SUCCESS',$6,$7)`,
      [agent.id, agent.tenant_id, task.id, task.priority, task.goal.substring(0, 200), JSON.stringify(actions.map(a => a.skill)), result.summary]
    )
  } catch (err) {
    console.error('[Memory] Non-critical error saving episodic memory:', err.message)
  }
}

/**
 * Extract a confidence score from a synthesis response.
 * Looks for explicit patterns like "confidence: 0.9" or "95% confident".
 * Falls back to a heuristic based on hedging language.
 */
function extractConfidence(text) {
  if (!text) return 0.5

  // Explicit decimal: "confidence: 0.85" or "confidence score: 0.9"
  const decimalMatch = text.match(/confidence(?:\s+score)?[:\s]+([0-1]\.\d+)/i)
  if (decimalMatch) return parseFloat(decimalMatch[1])

  // Explicit percentage: "95% confident" or "confidence: 90%"
  const percentMatch = text.match(/(\d{1,3})\s*%\s*confident|confidence[:\s]+(\d{1,3})\s*%/i)
  if (percentMatch) return parseFloat(percentMatch[1] || percentMatch[2]) / 100

  // Heuristic: penalise strong uncertainty language
  const lowConfidenceSignals = /\b(uncertain|unclear|unsure|cannot determine|unable to confirm|may not be|might not)\b/gi
  const highConfidenceSignals = /\b(successfully|completed|confirmed|verified|accurate|correct)\b/gi

  const lowCount = (text.match(lowConfidenceSignals) || []).length
  const highCount = (text.match(highConfidenceSignals) || []).length

  // Start at 0.75 baseline and nudge by signal counts
  return Math.min(0.99, Math.max(0.1, 0.75 + highCount * 0.03 - lowCount * 0.08))
}

function buildSystemPrompt(agent, skills) {
  const base = agent.system_prompt || `You are ${agent.name}, an AI agent. ${agent.description || ''}`
  const skillList = skills.length > 0
    ? `\n\nYour available skills:\n${skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}`
    : ''
  const rules = `\n\nCore rules:
- You MUST call the provided tools to retrieve real data. Never invent, guess, or fabricate results.
- If a tool is available that can answer the question, CALL IT — do not reason from memory.
- Be accurate and always cite the actual data returned by the tool.
- If uncertain about a value, call the relevant tool to verify it.
- Take the minimum necessary actions to complete the task.
- Prioritise accuracy over speed.`

  return base + skillList + rules
}

async function executeTool(toolName, input, agent, skills) {
  // Configured connector tool (Slack, Jira, GitHub, Gmail, Webhook, …)
  // Dispatched here so the LLM can call e.g. slack__post_message directly.
  if (CONNECTOR_TOOL_PREFIXES.some(p => toolName.startsWith(p))) {
    return executeConnectorTool(toolName, input, agent.tenant_id)
  }

  // Model Context Protocol (MCP) Tool Call
  if (toolName.startsWith('mcp__')) {
    try {
      // Format: mcp__[uuid_with_underscores]__[tool_name]
      const parts = toolName.split('__')
      if (parts.length < 3) throw new Error('Invalid MCP tool name format')

      const serverIdUnderscores = parts[1]
      const originalToolName = parts.slice(2).join('__')

      // Find the corresponding connector in DB to get its current config and verify tenant ownership
      const { rows } = await query(
        `SELECT id, name, config, auth_type FROM tool_connections 
         WHERE tenant_id = $1 AND REPLACE(id::text, '-', '_') = $2 AND tool_id = 'mcp'`,
        [agent.tenant_id, serverIdUnderscores]
      )

      if (rows.length === 0) {
        throw new Error(`MCP Server not found or access denied`)
      }

      const server = rows[0]
      // Decrypt stored credentials before sending to MCP server
      const decryptedConfig = { ...server.config, headers: decryptCredentials(server.config?.headers || {}) }
      const serverWithDecryptedConfig = { ...server, config: decryptedConfig }

      const result = await callMcpTool(serverWithDecryptedConfig, originalToolName, input)
      return { success: !result.isError, data: result.content }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // A2A — delegate to external agent
  if (toolName === 'a2a_call') {
    try {
      const { agentUrl, goal: delegateGoal } = input
      if (!agentUrl || !delegateGoal) return { success: false, error: 'agentUrl and goal are required' }

      // Only allow http(s) URLs and (in production) block private/loopback ranges to prevent SSRF
      const parsedUrl = (() => { try { return new URL(agentUrl) } catch { return null } })()
      if (!parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol)) {
        return { success: false, error: 'agentUrl must be a valid http(s) URL' }
      }
      if (process.env.NODE_ENV === 'production') {
        const host = parsedUrl.hostname
        if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|fc00:|fe80:)/i.test(host) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
          return { success: false, error: 'agentUrl must not target private/internal addresses' }
        }
      }

      // Issue a scoped short-lived call token identifying this delegation.
      // NEVER send JWT_SECRET as a bearer token — external endpoints could log it.
      const callToken = signA2ACallToken({ agentId: agent?.id, taskId: agent?._currentTaskId, agentUrl })
      const authHeader = { 'Authorization': `Bearer ${callToken}` }

      // Submit task
      const submitRes = await fetch(`${agentUrl}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ message: { parts: [{ text: delegateGoal }] } })
      })
      if (!submitRes.ok) return { success: false, error: `A2A submit failed: ${submitRes.status}` }
      const { id: remoteTaskId } = await submitRes.json()

      // Poll for completion (max 5 min)
      const deadline = Date.now() + 5 * 60 * 1000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000))
        const pollRes = await fetch(`${agentUrl}/tasks/${remoteTaskId}`, {
          headers: authHeader
        })
        if (!pollRes.ok) break
        const pollData = await pollRes.json()
        if (pollData.status?.state === 'completed') {
          const text = pollData.artifacts?.[0]?.parts?.[0]?.text || JSON.stringify(pollData)
          return { success: true, result: text }
        }
        if (pollData.status?.state === 'failed') {
          return { success: false, error: 'Remote agent task failed' }
        }
      }
      return { success: false, error: 'A2A task timed out' }
    } catch (err) {
      return { success: false, error: `A2A error: ${err.message}` }
    }
  }

  // Browser / computer use — delegates to sidecar service
  if (toolName === 'browser_use') {
    const browserUrl = process.env.BROWSER_AGENT_URL
    if (!browserUrl) return { success: false, error: 'Browser agent not configured (BROWSER_AGENT_URL not set)' }
    try {
      const res = await fetch(`${browserUrl}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Id': agent.id },
        body: JSON.stringify(input)
      })
      const data = await res.json()
      return { success: res.ok, ...data }
    } catch (err) {
      return { success: false, error: `Browser agent error: ${err.message}` }
    }
  }

  // HTTP request tool — built in
  if (toolName === 'http_request') {
    try {
      const response = await fetch(input.url, {
        method: input.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(input.headers || {}) },
        body: input.body ? JSON.stringify(input.body) : undefined
      })
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { data = text }
      return { success: response.ok, status: response.status, data }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // Find matching skill
  const skill = skills.find(s => s.name.replace(/\s+/g, '_').toLowerCase() === toolName)
  if (!skill) return { success: false, error: `Unknown tool: ${toolName}` }

  // Execute based on skill config
  if (skill.config?.url) {
    try {
      // Decrypt stored config credentials
      const decryptedSkillConfig = decryptCredentials(skill.config)

      // Build auth headers — prefer fresh OAuth token if skill is linked to a connector
      const authHeaders = {}
      if (skill.tool_connection_id) {
        try {
          const accessToken = await getValidAccessToken(agent.tenant_id, skill.tool_connection_id)
          authHeaders['Authorization'] = `Bearer ${accessToken}`
        } catch {
          // Fall back to any stored credentials in the decrypted config
          if (decryptedSkillConfig.apiKey) authHeaders['Authorization'] = `Bearer ${decryptedSkillConfig.apiKey}`
          else if (decryptedSkillConfig.token) authHeaders['Authorization'] = `Bearer ${decryptedSkillConfig.token}`
        }
      } else if (decryptedSkillConfig.apiKey) {
        authHeaders['Authorization'] = `Bearer ${decryptedSkillConfig.apiKey}`
      }

      const response = await fetch(decryptedSkillConfig.url, {
        method: decryptedSkillConfig.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(decryptedSkillConfig.headers || {}),
          ...authHeaders
        },
        body: JSON.stringify(input)
      })
      const data = await response.json()
      return { success: response.ok, status: response.status, data }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  return { success: false, error: 'Skill not yet implemented' }
}
