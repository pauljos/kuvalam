// apps/api/src/services/builder.service.js
// AI Builder Chatbot — creates agents, workflows, connectors, triggers, knowledge bases
// from natural-language user input, scoped to a single tenant/org.

import { complete } from './llm.service.js'
import { query } from '../db/pool.js'
import { generateAgentSystemPrompt } from './agent.service.js'

/**
 * Main builder chat entry point.
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.userId
 * @param {string} params.message - The user's natural-language request
 * @param {Array<{role:string,content:string}>} params.history - Prior conversation turns (max 20)
 * @returns {{ message: string, actions: Array, suggestions: Array<string> }}
 */
export async function builderChat({ tenantId, userId, message, history = [], userRole: jwtRole, isSystemAdmin: jwtIsSysAdmin }) {
  // 1. Gather tenant context
  const tenantCtx = await gatherTenantContext(tenantId)

  // 2. Look up user's role in this tenant (prefer DB, fallback to JWT)
  let userRole = jwtRole || 'VIEWER'
  let isSystemAdmin = jwtIsSysAdmin || false
  try {
    const { rows: [userRow] } = await query(
      `SELECT u.is_system_admin, tm.role FROM users u
       JOIN tenant_members tm ON tm.user_id = u.id AND tm.tenant_id = $1
       WHERE u.id = $2 AND tm.status = 'ACTIVE'`,
      [tenantId, userId]
    )
    if (userRow) {
      isSystemAdmin = userRow.is_system_admin
      userRole = userRow.role || 'VIEWER'
    }
  } catch { /* fallback to JWT claims */ }

  // 3. Build the system prompt (with role context)
  const systemPrompt = buildSystemPrompt(tenantCtx, userRole)

  // 4. Build messages array
  const messages = [
    { role: 'system', content: systemPrompt },
    ...(history.slice(-20)), // keep last 20 turns for context
    { role: 'user', content: message },
  ]

  // 5. Call LLM with function definitions — with retry loop for search-first-then-create pattern
  let actions = []
  let replyText = ''

  try {
    const result = await runBuilderLoop({ tenantId, userId, message, history, systemPrompt, tenantCtx, userRole, isSystemAdmin })
    actions = result.actions
    replyText = result.replyText
  } catch (err) {
    console.error('[builder] buildLoop error:', err.message)
    return {
      message: `I ran into an issue: ${err.message}. Could you try rephrasing your request?`,
      actions: [],
      suggestions: ['Try a simpler request', 'Check LLM configuration', 'Contact support'],
    }
  }

  return {
    message: replyText,
    actions,
    suggestions: generateSuggestions(actions, tenantCtx),
  }
}

// ─── Main builder loop (extracted for error isolation) ────────────────────────

async function runBuilderLoop({ tenantId, userId, message, history, systemPrompt, tenantCtx, userRole, isSystemAdmin = false }) {
  const SEARCH_ONLY_TOOLS = new Set(['search_existing', 'list_resources'])
  const messages = [
    { role: 'system', content: systemPrompt },
    ...(history.slice(-20)),
    { role: 'user', content: message },
  ]

  let currentMessages = messages
  let currentResult = await callLLM({ tenantId, messages: currentMessages, tenantCtx, userRole, goal: `Builder: ${message.slice(0, 80)}` })
  let actions = []
  let replyText = ''

  for (let attempt = 0; attempt < 2; attempt++) {
    const roundActions = []

    if (currentResult.toolCalls && currentResult.toolCalls.length > 0) {
      // Keep original OpenAI tool call structure for proper message reconstruction
      const toolCallsWithIds = currentResult.toolCalls.map(tc => ({
        id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        type: 'function',
        function: {
          name: tc.function?.name || tc.name,
          arguments: tc.function?.arguments || tc.arguments,
        },
      }))

      for (const tc of toolCallsWithIds) {
        const toolName = tc.function.name
        const toolArgs = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments
        try {
          const actionResult = await executeBuilderAction(
            { name: toolName, arguments: toolArgs },
            { tenantId, userId, userRole, isSystemAdmin, ctx: tenantCtx, userMessage: message }
          )
          roundActions.push({
            tool: toolName,
            toolCallId: tc.id,
            success: actionResult.success !== false,
            result: actionResult,
          })
        } catch (err) {
          roundActions.push({
            tool: toolName,
            toolCallId: tc.id,
            success: false,
            error: err.message,
          })
        }
      }

      actions.push(...roundActions)

      const onlySearches = roundActions.length > 0 && roundActions.every(a => SEARCH_ONLY_TOOLS.has(a.tool))

      if (onlySearches && attempt === 0) {
        // Build properly formatted tool result messages with tool_call_id
        const toolResultMessages = roundActions.map(a => {
          const r = a.result
          let content = ''
          if (r?.matches !== undefined) content = `search_existing found ${r.matches?.length || 0} matches for "${r.resourceType}"`
          else if (r?.items !== undefined) content = `list_resources found ${r.items?.length || 0} ${r.resourceType}(s)`
          else content = `${a.tool}: ${JSON.stringify(r)}`
          return { role: 'tool', tool_call_id: a.toolCallId, content }
        })

        currentMessages = [
          ...currentMessages,
          { role: 'assistant', content: null, tool_calls: toolCallsWithIds },
          ...toolResultMessages,
          { role: 'user', content: `No duplicates found. Now please CREATE what I asked for: "${message}". Call the appropriate create_* function now.` },
        ]
        currentResult = await callLLM({ tenantId, messages: currentMessages, tenantCtx, userRole, goal: `Builder retry: ${message.slice(0, 80)}` })
        continue
      }
    }

    replyText = currentResult.content || summarizeActions(actions)
    break
  }

  return { actions, replyText }
}

// ─── LLM call helper (wraps complete() with builder-specific config) ──────────

async function callLLM({ tenantId, messages, tenantCtx, userRole, goal }) {
  return complete({
    tenantId,
    agentId: 'builder-chatbot',
    messages,
    llmConfig: tenantCtx.llmConfig,
    useSystemLlm: true,
    temperature: 0.4,
    goal,
    tools: buildToolDefinitions(tenantCtx, userRole),
  })
}

// ─── Context Gathering ────────────────────────────────────────────────────────

async function gatherTenantContext(tenantId) {
  const { rows: [tenant] } = await query(
    'SELECT llm_config FROM tenants WHERE id = $1',
    [tenantId]
  )
  const llmConfig = tenant?.llm_config || {}

  // Existing agents
  const { rows: agents } = await query(
    `SELECT id, name, description, archetype, autonomy_level, status
     FROM agents WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [tenantId]
  )

  // Existing workflows
  const { rows: workflows } = await query(
    `SELECT id, name, description FROM workflows
     WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [tenantId]
  )

  // Existing connectors (tool_connections)
  const { rows: connectors } = await query(
    `SELECT id, tool_id as type, name, status as enabled, config FROM tool_connections
     WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [tenantId]
  )

  // Existing knowledge bases
  const { rows: knowledgeBases } = await query(
    `SELECT id, name, description FROM knowledge_bases
     WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [tenantId]
  )

  // Available providers from LLM config
  const providers = Object.keys(llmConfig?.providers || {})
  const defaultProvider = llmConfig?.defaultProvider || providers[0] || null

  return {
    tenantId,
    llmConfig,
    providers,
    defaultProvider,
    hasLlm: providers.length > 0,
    agents,
    workflows,
    connectors,
    knowledgeBases,
  }
}

// ─── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(ctx, userRole = 'VIEWER') {
  // What can this user create?
  const canCreateAgent = userRole === 'OWNER' || userRole === 'ADMIN' || userRole === 'MEMBER'
  const canCreateWorkflow = userRole === 'OWNER' || userRole === 'ADMIN' || userRole === 'MEMBER'
  const canCreateConnector = userRole === 'OWNER' || userRole === 'ADMIN'
  const canCreateKB = userRole === 'OWNER' || userRole === 'ADMIN' || userRole === 'MEMBER'
  const canCreateTrigger = userRole === 'OWNER' || userRole === 'ADMIN'

  const capabilities = []
  if (canCreateAgent) capabilities.push('  1. **Agents** — AI-powered autonomous agents with tools, knowledge, and skills')
  if (canCreateWorkflow) capabilities.push('  2. **Workflows** — Multi-step automations with agents, HTTP calls, conditions, approvals')
  if (canCreateConnector) capabilities.push('  3. **Connectors** — Integrations with Slack, Gmail, Jira, GitHub, WhatsApp, Telegram, etc.')
  if (canCreateKB) capabilities.push('  4. **Knowledge Bases** — Document collections for RAG (vector search)')
  if (canCreateTrigger) capabilities.push('  5. **Triggers** — Event-driven workflow starters (webhooks, schedules, conditions)')

  const roleInfo = userRole === 'VIEWER'
    ? '\n\n## YOUR ROLE: READ-ONLY\nYou can LIST and SEARCH resources, but you CANNOT create, modify, or delete anything. Politely tell users they have read-only access and suggest they contact an admin if they need to create resources. Do NOT call create_* functions.'
    : userRole === 'MEMBER'
      ? '\n\n## YOUR ROLE: MEMBER\nYou CAN create agents, workflows, and knowledge bases. You CANNOT create connectors or triggers — tell the user an Admin or Owner is required for those.'
      : userRole === 'ADMIN'
        ? '\n\n## YOUR ROLE: ADMIN\nYou CAN create all resources including connectors and triggers.'
        : '\n\n## YOUR ROLE: OWNER\nYou have full access to create all resources.'
  const agentList = ctx.agents.length > 0
    ? ctx.agents.map(a => `  - ${a.name} (${a.archetype || 'general'}, ${a.status || 'inactive'})`).join('\n')
    : '  (none yet)'

  const workflowList = ctx.workflows.length > 0
    ? ctx.workflows.map(w => `  - ${w.name}: ${w.description || 'no description'}`).join('\n')
    : '  (none yet)'

  const connectorList = ctx.connectors.length > 0
    ? ctx.connectors.map(c => `  - ${c.name} (type: ${c.type}, enabled: ${c.enabled})`).join('\n')
    : '  (none yet)'

  const kbList = ctx.knowledgeBases.length > 0
    ? ctx.knowledgeBases.map(k => `  - ${k.name}: ${k.description || 'no description'}`).join('\n')
    : '  (none yet)'

  const providerInfo = ctx.hasLlm
    ? ctx.providers.map(p => {
        const cfg = ctx.llmConfig.providers[p]
        return `  - ${p}${p === ctx.defaultProvider ? ' (default)' : ''} — model: ${cfg?.model || 'not set'}`
      }).join('\n')
    : '  ⚠️ No LLM providers configured yet. Tell the user to go to Settings to add one.'

  return `You are the **Kuvalam Builder Bot** — an AI assistant that helps users create and manage resources on the Kuvalam AI agent platform. You operate at the **organization (tenant) level** only.

## YOUR CAPABILITIES
You can CREATE, LIST, SEARCH, and ADVISE on these resources:
${capabilities.length > 0 ? capabilities.join('\n') : '  (read-only access — you can only list and search existing resources)'}

## CURRENT ORGANIZATION STATE
**LLM Providers configured:** ${ctx.hasLlm ? ctx.providers.length : 0}
${providerInfo}

**Existing Agents (${ctx.agents.length}):**
${agentList}

**Existing Workflows (${ctx.workflows.length}):**
${workflowList}

**Existing Connectors (${ctx.connectors.length}):**
${connectorList}

**Knowledge Bases (${ctx.knowledgeBases.length}):**
${kbList}
${roleInfo}

## HOW TO HELP
- **When a user asks to CREATE something, call the create function IMMEDIATELY — DO NOT search first and DO NOT ask clarifying questions.** Infer sensible defaults from the user's request: derive the name from what they said, use the default LLM provider, pick the best archetype.
- **Only ask clarifying questions if CRITICAL info is missing** (e.g., a workflow with no steps, a trigger with no workflow ID). A user saying "create a news agent" is enough — name it after their topic, set archetype to 'research', use defaults.
- If you truly need to check for duplicates first, call BOTH search_existing AND the create_* function TOGETHER in a single response so both execute.
- **When a user asks to LIST or SEARCH, call list_resources or search_existing** and present the results clearly.
- After creating something, show a summary with links (use the returned ID).
- If the user asks about something you can't do, politely explain your scope.
- For agent creation, derive name from user request. Use these archetypes as appropriate: analytics (data-analyst), coordinator, communication (customer-support), compliance, planner, research, document, developer, data-entry, agent-generation.
- For agent LLM selection: use the default provider unless user specifies otherwise.

## RULES
- **CREATE immediately.** When the user says "create", "build", "make", "set up", "add", or "I need" — call the create_* function straight away with sensible defaults. No searching. No asking questions.
- If you DO search first and find nothing, you MUST also include the create_* call in the SAME tool call batch.
- Keep responses concise — 3 sentences max after executing.
- Scope everything to this organization. Never reference other organizations.
- If no LLM is configured, tell the user they need to set one up in Settings first.
- After creating, suggest one logical next step.`
}

// ─── Tool Definitions (Function Calling) ──────────────────────────────────────

function buildToolDefinitions(ctx, userRole = 'VIEWER') {
  const canCreateAgent = userRole === 'OWNER' || userRole === 'ADMIN' || userRole === 'MEMBER'
  const canCreateWorkflow = userRole === 'OWNER' || userRole === 'ADMIN' || userRole === 'MEMBER'
  const canCreateConnector = userRole === 'OWNER' || userRole === 'ADMIN'
  const canCreateKB = userRole === 'OWNER' || userRole === 'ADMIN' || userRole === 'MEMBER'
  const canCreateTrigger = userRole === 'OWNER' || userRole === 'ADMIN'

  const tools = []

  // Everyone can search and list
  tools.push(
    {
      name: 'search_existing',
      description: 'Search existing resources to avoid duplicates before creating.',
      parameters: {
        type: 'object',
        properties: {
          resourceType: { type: 'string', enum: ['agent', 'workflow', 'connector', 'knowledge_base'] },
          query: { type: 'string', description: 'Search term' },
        },
        required: ['resourceType', 'query'],
      },
    },
    {
      name: 'list_resources',
      description: 'List existing resources of a given type.',
      parameters: {
        type: 'object',
        properties: {
          resourceType: { type: 'string', enum: ['agent', 'workflow', 'connector', 'knowledge_base', 'trigger'] },
        },
        required: ['resourceType'],
      },
    }
  )

  // Role-restricted create tools
  if (canCreateAgent) {
    tools.push({
      name: 'create_agent',
      description: 'Create a new AI agent. ALWAYS include the name field — derive it from what the user asked for (e.g. "Malayalam News Reporter", "SQL Data Analyst", "Slack Notification Bot").',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'REQUIRED. A descriptive name derived from the user request. Example: "Malayalam News Reporter", "Support Agent", "Data Analyzer".' },
          description: { type: 'string', description: 'One-line summary of what the agent does. Optional — will default to name if omitted.' },
          archetype: { type: 'string', enum: ['analytics', 'data-analyst', 'planner', 'research', 'compliance', 'document', 'communication', 'customer-support', 'coordinator', 'developer', 'data-entry', 'agent-generation'], description: 'Optional. Default: research for news/info agents, analytics for data, coordinator for multi-step.' },
          systemPrompt: { type: 'string', description: 'Optional detailed instructions. Default: auto-generated from name+description.' },
          autonomyLevel: { type: 'string', enum: ['SUPERVISED', 'GUARDED', 'AUTONOMOUS'], description: 'Optional. Default: SUPERVISED.' },
          llmProvider: { type: 'string', description: `Optional. Available: ${ctx.providers.join(', ') || 'none configured'}. Default: ${ctx.defaultProvider || 'none'}` },
          llmModel: { type: 'string', description: 'Optional model name.' },
        },
        required: ['name'],
      },
    })
  }

  if (canCreateWorkflow) {
    tools.push({
      name: 'create_workflow',
      description: 'Create a new automation workflow.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Workflow name (max 5 words)' },
          description: { type: 'string', description: 'What the workflow does. Optional.' },
          steps: { type: 'array', description: 'Optional. Array of workflow step objects. Leave empty for a basic placeholder flow.' },
          triggerType: { type: 'string', enum: ['manual', 'WEBHOOK', 'SCHEDULE'], description: 'How the workflow starts (default: manual)' },
          triggerConfig: { type: 'object', description: 'Trigger configuration (cron expression for SCHEDULE, secret for WEBHOOK)' },
        },
        required: ['name'],
      },
    })
  }

  if (canCreateConnector) {
    tools.push({
      name: 'create_connector',
      description: 'Create a new integration connector for an external service.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Display name for this connector' },
          type: { type: 'string', description: 'Connector type: slack, gmail, discord, sendgrid, twilio, jira, github, whatsapp, telegram, mqtt, thingsboard, aws, prometheus, datadog, elasticsearch, snowflake, k8s, terraform, docker, ssh, service_now, zendesk, salesforce, hubspot, stripe, confluence' },
          config: { type: 'object', description: 'Connector-specific configuration (API keys, tokens, URLs, etc.)' },
          enabled: { type: 'boolean', description: 'Whether to enable immediately (default: true)' },
        },
        required: ['name', 'type', 'config'],
      },
    })
  }

  if (canCreateKB) {
    tools.push({
      name: 'create_knowledge_base',
      description: 'Create a new knowledge base (document collection for RAG).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Knowledge base name' },
          description: { type: 'string', description: 'What kind of knowledge it contains' },
        },
        required: ['name'],
      },
    })
  }

  if (canCreateTrigger) {
    tools.push({
      name: 'create_trigger',
      description: 'Create a trigger that automatically starts a workflow.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Trigger name' },
          workflowId: { type: 'string', description: 'ID of the workflow to trigger' },
          triggerType: { type: 'string', enum: ['WEBHOOK', 'SCHEDULE', 'CONDITION', 'EVENT'] },
          config: { type: 'object', description: 'Trigger config: { cron, secret, condition, event }' },
        },
        required: ['name', 'workflowId', 'triggerType'],
      },
    })
  }

  return tools
}

// ─── Action Executor ──────────────────────────────────────────────────────────

async function executeBuilderAction(toolCall, { tenantId, userId, userRole = 'VIEWER', isSystemAdmin = false, ctx = {}, userMessage = '' }) {
  const { name, arguments: args } = toolCall
  const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args

  // ── Defensive: generate fallback name if LLM omitted it (CREATE actions only) ──
  const isCreateAction = name && name.startsWith('create_')
  if (isCreateAction && (!parsedArgs.name || parsedArgs.name.trim() === '')) {
    // Try to derive a good name from the user's original message
    if (userMessage && userMessage.trim()) {
      // Extract the key intent: "Create an agent that can provide top malayalam news daily"
      // → "Malayalam News Agent"
      const cleaned = userMessage
        .replace(/^(create|build|make|set up|add|i need|i want|please)\s+(a|an|the)\s+/i, '')
        .replace(/^(agent|workflow|connector|trigger|knowledge base)\s+(that|which|to|for|can|called|named)\s+/i, '')
        .replace(/\s+(that|which|to|for|can|will|should|must|who)\s+.*$/i, '')
        .replace(/[:?.!,;].*$/, '')
        .replace(/[""''`]/g, '')  // strip quotes
        .trim()
      if (cleaned.length > 3) {
        // Capitalize each word, limit to 5 words
        const words = cleaned.split(/\s+/).slice(0, 5)
        parsedArgs.name = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
        if (parsedArgs.name.length > 50) parsedArgs.name = parsedArgs.name.slice(0, 47) + '...'
      }
    }
    // Fall through to secondary fallbacks
    if (!parsedArgs.name || parsedArgs.name.trim() === '') {
      if (parsedArgs.description && parsedArgs.description.trim()) {
        const words = parsedArgs.description.trim().split(/\s+/).slice(0, 4)
        parsedArgs.name = words.join(' ') + (words.length >= 4 ? '...' : '')
      } else {
        const kind = name.replace('create_', '').replace(/_/g, ' ')
        parsedArgs.name = `New ${kind} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      }
    }
    if (parsedArgs.name.length > 60) parsedArgs.name = parsedArgs.name.slice(0, 57) + '...'
    console.warn(`[builder] LLM omitted 'name' for ${name}; generated fallback: "${parsedArgs.name}"`)
  }

  // ── RBAC Permission Checks ─────────────────────────────────────────────────
  const canCreateAgent = isSystemAdmin || userRole === 'OWNER' || userRole === 'ADMIN' || userRole === 'MEMBER'
  const canCreateWorkflow = isSystemAdmin || userRole === 'OWNER' || userRole === 'ADMIN' || userRole === 'MEMBER'
  const canCreateConnector = isSystemAdmin || userRole === 'OWNER' || userRole === 'ADMIN'
  const canCreateKB = isSystemAdmin || userRole === 'OWNER' || userRole === 'ADMIN' || userRole === 'MEMBER'
  const canCreateTrigger = isSystemAdmin || userRole === 'OWNER' || userRole === 'ADMIN'

  const permDenied = (resource) => ({ success: false, error: `Permission denied: your role (${userRole}) does not allow creating ${resource}. An Owner or Admin is required.` })

  switch (name) {
    case 'create_agent': {
      if (!canCreateAgent) return permDenied('agents')
      const { createAgent } = await import('./agent.service.js')
      // Auto-derive defaults for optional fields the LLM may omit
      const agentName = parsedArgs.name
      const agentDesc = parsedArgs.description || `Agent for: ${agentName}`
      const agentArchetype = parsedArgs.archetype || inferArchetype(agentName, agentDesc)

      // ── Generate rich archetype-specific system prompt ────────────────────
      // Use the shared helper instead of the bare "You are X" default.
      const systemPrompt = parsedArgs.systemPrompt
        || generateAgentSystemPrompt(agentName, agentDesc, agentArchetype)

      // ── Derive autonomy level from archetype ──────────────────────────────
      const AUTONOMOUS_ARCHETYPES = new Set(['coordinator', 'planner', 'agent-generation', 'orchestrator'])
      const autonomyLevel = parsedArgs.autonomyLevel
        || (AUTONOMOUS_ARCHETYPES.has(agentArchetype) ? 'AUTONOMOUS' : 'SUPERVISED')

      const provider = parsedArgs.llmProvider || ctx.defaultProvider
      const model = parsedArgs.llmModel || (provider && ctx.llmConfig?.providers?.[provider]?.model) || undefined

      const agent = await createAgent({
        tenantId,
        userId,
        data: {
          name: agentName,
          description: agentDesc,
          archetype: agentArchetype,
          systemPrompt,
          autonomyLevel,
          llmProvider: provider,
          llmModel: model,
          confidenceThreshold: 0.75,
        },
      })
      return {
        resourceType: 'agent',
        id: agent.id,
        name: agent.name,
        archetype: agent.archetype,
        autonomyLevel,
        url: `/dashboard/agents/${agent.id}`,
      }
    }

    case 'create_workflow': {
      if (!canCreateWorkflow) return permDenied('workflows')
      const { createWorkflow } = await import('./workflow.service.js')
      // Supply sensible defaults: empty steps = basic placeholder workflow
      const wfSteps = (parsedArgs.steps && parsedArgs.steps.length > 0)
        ? parsedArgs.steps
        : [{ id: 'step-1', type: 'notify', input: { message: `Workflow "${parsedArgs.name}" executed successfully.` } }]
      const wfDesc = parsedArgs.description || `Workflow for: ${parsedArgs.name}`
      const wf = await createWorkflow(tenantId, {
        name: parsedArgs.name,
        description: wfDesc,
        steps: wfSteps,
        trigger: parsedArgs.triggerType ? {
          type: parsedArgs.triggerType,
          config: parsedArgs.triggerConfig || {},
        } : undefined,
        userId,
      })
      return {
        resourceType: 'workflow',
        id: wf.id,
        name: wf.name,
        url: `/dashboard/workflows`,
      }
    }

    case 'create_connector': {
      if (!canCreateConnector) return permDenied('connectors')
      if (!parsedArgs.type) {
        return { success: false, error: 'Connector type is required. Please specify the service (e.g., slack, gmail, github).' }
      }
      const { getConnectorToolDefinitions } = await import('./connector-tools.service.js')
      const tools = await getConnectorToolDefinitions(tenantId)
      const matchingTool = tools.find(t => t.type === parsedArgs.type || t.name === parsedArgs.type || t.tool_id === parsedArgs.type)
      const toolId = matchingTool?.tool_id || matchingTool?.id
      if (!toolId) {
        return { success: false, error: `Unknown connector type: "${parsedArgs.type}". Available: ${tools.map(t => t.tool_id || t.type || t.name).join(', ')}` }
      }
      const { encryptCredentials } = await import('./crypto.service.js')
      const encryptedConfig = encryptCredentials ? encryptCredentials(parsedArgs.config || {}) : JSON.stringify(parsedArgs.config || {})

      const { rows: [conn] } = await query(
        `INSERT INTO tool_connections (tenant_id, tool_id, name, auth_type, config, deployment_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING') RETURNING id, name`,
        [tenantId, toolId, parsedArgs.name, 'API_KEY', encryptedConfig, 'cloud']
      )
      return {
        resourceType: 'connector',
        id: conn.id,
        name: conn.name,
        type: parsedArgs.type,
        url: `/dashboard/connectors`,
      }
    }

    case 'create_knowledge_base': {
      if (!canCreateKB) return permDenied('knowledge bases')
      const { createKnowledgeBase } = await import('./knowledge.service.js')
      const kb = await createKnowledgeBase({
        tenantId,
        name: parsedArgs.name,
        description: parsedArgs.description || '',
        userId,
      })
      return {
        resourceType: 'knowledge_base',
        id: kb.id,
        name: kb.name,
        url: `/dashboard/knowledge`,
      }
    }

    case 'create_trigger': {
      if (!canCreateTrigger) return permDenied('triggers')
      if (!parsedArgs.workflowId) {
        return { success: false, error: 'workflowId is required. Provide the ID of the workflow to attach this trigger to.' }
      }
      const triggerType = parsedArgs.triggerType || 'WEBHOOK'
      const { rows: [trigger] } = await query(
        `INSERT INTO workflow_triggers (tenant_id, workflow_id, trigger_type, name, config)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [tenantId, parsedArgs.workflowId, triggerType, parsedArgs.name, parsedArgs.config || {}]
      )
      return {
        resourceType: 'trigger',
        id: trigger.id,
        name: trigger.name,
        url: `/dashboard/triggers`,
      }
    }

    case 'search_existing': {
      const results = await searchResources(tenantId, parsedArgs.resourceType, parsedArgs.query)
      return { resourceType: parsedArgs.resourceType, matches: results }
    }

    case 'list_resources': {
      const items = await listResources(tenantId, parsedArgs.resourceType)
      return { resourceType: parsedArgs.resourceType, items }
    }

    default:
      return { success: false, error: `Unknown action: ${name}` }
  }
}

// ─── Resource Search / List ───────────────────────────────────────────────────

async function searchResources(tenantId, resourceType, searchQuery) {
  const tableMap = {
    agent: { table: 'agents', fields: 'id, name, description, archetype', searchField: 'name' },
    workflow: { table: 'workflows', fields: 'id, name, description', searchField: 'name' },
    connector: { table: 'tool_connections', fields: 'id, name, tool_id as type, status as enabled', searchField: 'name' },
    knowledge_base: { table: 'knowledge_bases', fields: 'id, name, description', searchField: 'name' },
  }
  const mapping = tableMap[resourceType]
  if (!mapping) return []

  const { rows } = await query(
    `SELECT ${mapping.fields} FROM ${mapping.table}
     WHERE tenant_id = $1 AND ${mapping.searchField} ILIKE $2
     ORDER BY created_at DESC LIMIT 5`,
    [tenantId, `%${searchQuery}%`]
  )
  return rows
}

async function listResources(tenantId, resourceType) {
  const tableMap = {
    agent: { table: 'agents', fields: 'id, name, description, archetype, status' },
    workflow: { table: 'workflows', fields: 'id, name, description' },
    connector: { table: 'tool_connections', fields: 'id, name, tool_id as type, status as enabled' },
    knowledge_base: { table: 'knowledge_bases', fields: 'id, name, description' },
    trigger: { table: 'workflow_triggers', fields: 'id, name, trigger_type, is_active' },
  }
  const mapping = tableMap[resourceType]
  if (!mapping) return []

  const { rows } = await query(
    `SELECT ${mapping.fields} FROM ${mapping.table}
     WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [tenantId]
  )
  return rows
}

// ─── Response Helpers ─────────────────────────────────────────────────────────

/**
 * Infer the best agent archetype from the name and description.
 * Defaults to 'research' for news/info gathering, 'analytics' for data,
 * 'communication' for messaging/social, 'coordinator' for workflows.
 */
function inferArchetype(name, description) {
  const text = `${name} ${description}`.toLowerCase()
  // These map directly to scope preset keys
  if (/create.*(agent|workflow|trigger)|meta.?agent|oversee|orchestrat.*agent|agent.*generat/i.test(text)) return 'agent-generation'
  if (/news|headline|article|feed|rss|daily|weekly|research|summar/i.test(text)) return 'research'
  if (/data|analy|sql|chart|graph|dash|metric|statistic|insight|engineer|civil|structural|architect|design|model|calc|simulation|knowledge.graph|ontology|rag|retriev|vector.search|embedding|semantic|entity/i.test(text)) return 'analytics'
  if (/message|chat|notif|alert|slack|email|whatsapp|telegram|social|support|customer/i.test(text)) return 'communication'
  if (/browser|automation|data.entry|form.*(fill|entry)|scrap|type.*into|click.*button|navigate.*web/i.test(text)) return 'data-entry'
  if (/code|program|develop|debug|refactor|git|pr|pull.request|commit|build.*app|(write|fix).*code/i.test(text)) return 'developer'
  if (/workflow|orchestrat|pipeline|multi.?step|chain|approval/i.test(text)) return 'coordinator'
  if (/doc|pdf|template|write|draft|content|blog/i.test(text)) return 'document'
  if (/compliance|audit|policy|legal|regulat|grc|risk|finance/i.test(text)) return 'compliance'
  if (/plan|task|project|todo|schedule|organiz/i.test(text)) return 'planner'
  return 'research' // default for unknown types
}

function summarizeActions(actions) {
  if (actions.length === 0) return ''

  const successes = actions.filter(a => a.success)
  const failures = actions.filter(a => !a.success)

  // Separate by result type
  const created = successes.filter(a => a.result?.name && a.result?.url)
  const searches = successes.filter(a => a.result?.matches && !a.result?.name)
  const lists = successes.filter(a => a.result?.resources && !a.result?.name && !a.result?.matches)
  const other = successes.filter(a => !created.includes(a) && !searches.includes(a) && !lists.includes(a))

  let summary = ''

  if (searches.length > 0) {
    for (const a of searches) {
      const r = a.result
      summary += `🔍 Found ${r.matches?.length || 0} ${r.resourceType || 'resource'}${r.matches?.length !== 1 ? 's' : ''} matching your query.\n`
    }
  }

  if (lists.length > 0) {
    for (const a of lists) {
      const r = a.result
      summary += `📋 Listed ${r.resources?.length || 0} ${r.resourceType || 'resource'}${r.resources?.length !== 1 ? 's' : ''}.\n`
    }
  }

  if (created.length > 0) {
    summary += '✅ **Created:**\n'
    for (const a of created) {
      const r = a.result
      summary += `- ${r.resourceType || 'resource'}: **${r.name || 'unnamed'}** ([view](${r.url || '#'}))\n`
    }
  }

  if (other.length > 0) {
    summary += '✅ Done.\n'
  }

  if (failures.length > 0) {
    summary += '\n❌ **Failed:**\n'
    for (const a of failures) {
      summary += `- ${a.tool}: ${a.error}\n`
    }
  }

  return summary || 'Done!'
}

function generateSuggestions(actions, ctx) {
  const suggestions = []

  // If they just created an agent, suggest next steps
  const createdAgent = actions.find(a => a.success && a.result?.resourceType === 'agent')
  if (createdAgent) {
    suggestions.push(`Configure tools for "${createdAgent.result.name}"`)
    suggestions.push(`Create a workflow that uses "${createdAgent.result.name}"`)
    if (ctx.knowledgeBases.length > 0) {
      suggestions.push(`Link a knowledge base to "${createdAgent.result.name}"`)
    }
  }

  // If they created a workflow, suggest triggers
  const createdWorkflow = actions.find(a => a.success && a.result?.resourceType === 'workflow')
  if (createdWorkflow) {
    suggestions.push(`Add a webhook trigger for "${createdWorkflow.result.name}"`)
    suggestions.push(`Add a schedule trigger for "${createdWorkflow.result.name}"`)
  }

  // If they created a knowledge base, suggest adding documents
  const createdKb = actions.find(a => a.success && a.result?.resourceType === 'knowledge_base')
  if (createdKb) {
    suggestions.push(`Upload documents to "${createdKb.result.name}"`)
    suggestions.push(`Link "${createdKb.result.name}" to an agent`)
  }

  // Always suggest common actions
  suggestions.push('Create a data analysis agent')
  suggestions.push('Create a notification workflow')
  suggestions.push('Set up a webhook trigger')

  return [...new Set(suggestions)].slice(0, 5)
}
