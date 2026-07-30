// apps/api/src/services/task.service.js
// Agent task execution loop — Plan → Execute → Synthesise
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { createWriteStream, existsSync } from 'fs'
import { query } from '../db/pool.js'
import { complete, completeStream, embed } from './llm.service.js'
import { searchKnowledge } from './knowledge.service.js'
import { auditLog } from '../utils/audit.js'
import { AppError } from '../utils/errors.js'
import { enqueueTask } from './queue.service.js'
import { decryptCredentials } from './crypto.service.js'
import { listTables, describeTable, runQuery } from './database-connector.service.js'
import { saveReport } from './reports.service.js'
import { getTenantMcpServers, listMcpTools, callMcpTool } from './mcp.service.js'
import { getValidAccessToken } from './oauth.service.js'
import { broadcastTelemetry } from './telemetry.service.js'
import { extractAndStoreMemory, retrieveMemory } from './memory.service.js'
import {
  getConnectorToolDefinitions,
  executeConnectorTool,
  CONNECTOR_TOOL_PREFIXES,
} from './connector-tools.service.js'
import { createWorkflow } from './workflow.service.js'
import { createAgent, generateAgentSystemPrompt } from './agent.service.js'
import { executeCustomSkill, executePythonSkill } from './skill-executor.service.js'
import { cached } from './cache.service.js'
import { hashKey, safeParseJSON, tryParseToolCallFromText, signA2ACallToken } from './task-json-repair.js'
import { retrieveKnowledge, loadEpisodicMemory, saveEpisodicMemory } from './task-knowledge.js'
import { extractConfidence, buildRichReportHtml, buildSvgReportHtml, buildD3ReportHtml, buildMixedReportHtml, sanitiseReportHtml, synthesiseReportHtml, markdownToReportHtml, buildSystemPrompt } from './task-reports.js'
import { resolveAgentScopes, addScope, getArchetypeScopePresets } from './agent-scope.service.js'
import { searchFiles, assertSafeUrl, isValidDockerImage, isValidHost, safeSpawn } from '../utils/safe-exec.js'
import {
  requiresApproval,
  createApprovalRequest,
  AUTONOMY_LEVELS,
} from './hitl.service.js'

export async function dispatchTask({ tenantId, agentId, goal, context = {}, priority = 'MEDIUM', userId, attachments = [] }) {
  // Input validation
  if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
    throw new AppError('MISSING_GOAL', 'Task goal is required and must be a non-empty string', 400)
  }
  if (goal.length > 100_000) {
    throw new AppError('GOAL_TOO_LONG', 'Task goal must be 100,000 characters or fewer', 400)
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

  await auditLog({
    eventType: 'agent.task_queued', tenantId, actorId: agentId, actorType: 'AGENT',
    resourceType: 'AgentTask', resourceId: task.id, action: 'QUEUE_TASK',
    metadata: {
      agentName: agent.name,
      goal: goal.slice(0, 200),
      priority: priority || 'NORMAL',
      createdBy: userId
    }
  })

  // Enqueue via BullMQ (falls back to setImmediate if Redis unavailable)
  console.log(`[Dispatch] Task ${task.id} enqueuing for agent ${agent.name} (${agent.id}), goal: "${goal.slice(0, 80)}"`)
  await enqueueTask(task, agent, executeTask)
  console.log(`[Dispatch] Task ${task.id} enqueued successfully`)

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
  const TASK_TIMEOUT_MS = parseInt(process.env.TASK_TIMEOUT_MS || '600000') // 10 minutes default

  // Idempotency check: prevent re-execution if already running/completed
  const { rows: [dbTask] } = await query(
    'SELECT status, approval_id, context FROM agent_tasks WHERE id = $1 AND tenant_id = $2',
    [task.id, tenantId]
  )
  
  if (dbTask?.status === 'RUNNING') {
    console.warn(`[Task ${task.id}] Already running, skipping duplicate execution`)
    return { success: false, error: 'Task is already running' }
  }

  if (dbTask?.status === 'COMPLETED') {
    console.warn(`[Task ${task.id}] Already completed, skipping duplicate execution`)
    return { success: true, result: dbTask.result, skipped: true }
  }

  if (dbTask?.status === 'FAILED') {
    console.warn(`[Task ${task.id}] Already failed, skipping duplicate execution`)
    return { success: false, error: dbTask.error || 'Task has already failed', skipped: true }
  }

  // ── HITL RESUME DETECTION ──────────────────────────────────────────────
  // If the task is in AWAITING_APPROVAL status, it means we're being re-dispatched
  // after an approval was granted (or the process restarted while waiting).
  // Check the approval status and either continue waiting or resume execution.
  if (dbTask?.status === 'AWAITING_APPROVAL') {
    const approvalId = dbTask.approval_id

    // Reload the full task from DB so we have the latest context (including resume flags)
    const { rows: [reloadedTask] } = await query(
      'SELECT * FROM agent_tasks WHERE id = $1 AND tenant_id = $2',
      [task.id, tenantId]
    )
    if (reloadedTask) {
      task = reloadedTask
    }

    if (!approvalId) {
      console.warn(`[Task ${task.id}] AWAITING_APPROVAL but no approval_id — resuming as new`)
      await query(`UPDATE agent_tasks SET status = 'RUNNING' WHERE id = $1`, [task.id])
    } else {
      const { rows: [pendingApproval] } = await query(
        `SELECT status, decision_note, tool_name, tool_input, modified_input FROM approval_requests WHERE id = $1`,
        [approvalId]
      )

      if (!pendingApproval || pendingApproval.status === 'REJECTED' || pendingApproval.status === 'EXPIRED') {
        // Approval was rejected while we were gone — mark task as failed
        const reason = pendingApproval?.decision_note || 'Approval was rejected or expired'
        await query(
          `UPDATE agent_tasks SET status = 'FAILED', error = $1, approval_id = NULL, completed_at = NOW() WHERE id = $2`,
          [reason, task.id]
        )
        return { success: false, error: reason }
      }

      if (pendingApproval.status === 'APPROVED') {
        // Approval was granted — restore and continue execution
        console.log(`[Task ${task.id}] Approval granted, resuming execution`)

        // Inject resume context so executeTool knows which tool was already approved
        // and can skip the approval check for it
        const resumeCtx = {
          _resumeFromApproval: true,
          _approvedTool: pendingApproval.tool_name,
          _approvedInput: pendingApproval.modified_input || pendingApproval.tool_input,
        }

        // Merge resume context into the task's context column for downstream use
        const taskContext = typeof task.context === 'object' && task.context !== null
          ? { ...task.context, ...resumeCtx }
          : resumeCtx

        await query(
          `UPDATE agent_tasks SET status = 'RUNNING', approval_id = NULL, context = $1 WHERE id = $2`,
          [JSON.stringify(taskContext), task.id]
        )

        // Update the in-memory task object so downstream code sees resume flags
        task.context = taskContext

        // Continue below to mark as running and restore checkpoint
      } else {
        // Still PENDING — wait again
        console.log(`[Task ${task.id}] Still pending approval, waiting again...`)
        // Just mark as running and the executeTool call will trigger the wait again
        await query(`UPDATE agent_tasks SET status = 'RUNNING' WHERE id = $1`, [task.id])
      }
    }
  }

  // Mark as running
  const isResume = dbTask?.status === 'AWAITING_APPROVAL'
  if (!isResume) {
    await query(`UPDATE agent_tasks SET status = 'RUNNING', started_at = NOW() WHERE id = $1 AND tenant_id = $2`, [task.id, tenantId])
  }
  broadcastTelemetry(tenantId, 'agent.task_started', { taskId: task.id, agentId: agent.id, agentName: agent.name, resume: isResume })

  const actions = []
  let totalTokens = { prompt: 0, completion: 0, total: 0 }

  // Task-level timeout — sets a flag checked before LLM calls.
  // Per-call LLM timeouts (llm.service.js) are the primary defence against hangs,
  // this is a hard safety net for extremely long-running tasks.
  let taskTimedOut = false
  const timeoutId = setTimeout(() => {
    taskTimedOut = true
    console.error(`[Task ${task.id}] TIMED OUT after ${TASK_TIMEOUT_MS}ms`)
  }, TASK_TIMEOUT_MS)

  try {
    let agentDbConnectionString = null
    let agentDbConnectionMap = null  // Map<label, {connectionString, dbType}> for multi-DB

    // 1. Load agent skills as tools
    const { rows: skills } = await query(
      'SELECT * FROM agent_skills WHERE agent_id = $1 AND is_enabled = true',
      [agent.id]
    )

    // ── Build toolDefinitions here (before hasDataTools check at line ~656) ──
    // IMPORTANT: must be declared BEFORE hasDataTools is evaluated so there
    // is no temporal dead zone. Skills are the only source at this point;
    // connector/MCP/built-in tools are pushed into this array later.
    const toolDefinitions = skills.map(s => ({
      name: s.name.replace(/\s+/g, '_').toLowerCase(),
      description: s.description || `Execute the ${s.name} skill`,
      inputSchema: s.config?.inputSchema || { type: 'object', properties: { input: { type: 'string' } } }
    }))

    // 2. Retrieve relevant knowledge
    const knowledgeContext = await retrieveKnowledge(agent, task.goal)

    // 3. Load agent's episodic memory (past similar tasks)
    const episodicContext = await loadEpisodicMemory(agent.id, task.goal)

    // 3b. Load long-term entity memory
    const longTermMemory = await retrieveMemory(agent.id, task.goal)

    // ── DB CONNECTION RESOLUTION (runs BEFORE buildSystemPrompt so
    // schema preload can set _schemaPreloaded before the prompt is built) ──
    if (!agentDbConnectionString) {
      try {
        const { rows: dbRows } = await query(
          `SELECT cmd.db_label, cmd.db_connection_string, cmd.db_type,
                  cm.model_name
           FROM custom_model_databases cmd
           JOIN custom_models cm ON cm.id = cmd.model_id
           WHERE cm.tenant_id = $1
             AND cm.data_source IN ('database', 'nosql')
             AND cm.status = 'COMPLETED'
             AND cmd.db_connection_string IS NOT NULL
             AND cmd.db_connection_string != ''
             AND (cm.model_name = $2
                  OR cm.model_name = split_part($2, ':', 1)
                  OR cm.model_name LIKE $2 || '_%')
           ORDER BY cmd.sort_order`,
          [agent.tenant_id, agent.llm_model]
        )
        if (dbRows.length > 1) {
          agentDbConnectionMap = new Map()
          for (const row of dbRows) {
            agentDbConnectionMap.set(row.db_label, {
              connectionString: row.db_connection_string,
              dbType: row.db_type,
            })
          }
          agentDbConnectionString = dbRows[0].db_connection_string
          agent._dbConnectionString = agentDbConnectionString
          agent._dbConnectionMap = agentDbConnectionMap
          agent._isTrainedModel = true  // mark: DB resolved from trained custom model
        } else if (dbRows.length === 1) {
          agentDbConnectionString = dbRows[0].db_connection_string
          agent._dbConnectionString = agentDbConnectionString
          agent._isTrainedModel = true  // mark: DB resolved from trained custom model
        }
      } catch { /* junction may not exist, try legacy below */ }

      // Legacy fallback
      if (!agentDbConnectionString) {
        try {
          const { rows: [customModel] } = await query(
            `SELECT db_connection_string FROM custom_models
             WHERE tenant_id = $1 AND data_source = 'database' AND status = 'COMPLETED'
               AND db_connection_string IS NOT NULL AND db_connection_string != ''
               AND model_name = $2
             LIMIT 1`,
            [agent.tenant_id, agent.llm_model]
          )
          if (customModel?.db_connection_string) {
            agentDbConnectionString = customModel.db_connection_string
            agent._dbConnectionString = agentDbConnectionString
          }
        } catch {}
      }

      // ── Connector-scope fallback: resolve DB connection from agent's
      // database/postgres connectors when no custom-model DB is found.
      // This ensures agents with a SQL Database connector (but no trained
      // custom model) can use listTables/describeTable/runQuery directly. ──
      if (!agentDbConnectionString) {
        try {
          const { rows: connRows } = await query(
            `SELECT tc.config, tc.id
             FROM agent_tool_scopes ats
             JOIN tool_connections tc ON ats.connector_id = tc.id
             WHERE ats.agent_id = $1 AND ats.scope_type = 'connector'
               AND tc.tool_id IN ('database', 'postgres')
               AND tc.status = 'ACTIVE'
             ORDER BY tc.created_at ASC LIMIT 1`,
            [agent.id]
          )
          const cfg = connRows[0]?.config
          if (cfg) {
            // Decrypt any encrypted credential fields (password, apiKey, etc.)
            const decrypted = decryptCredentials(cfg)
            const host = decrypted.host || 'localhost'
            const port = decrypted.port || '5432'
            const user = decrypted.user || decrypted.username || 'postgres'
            const database = decrypted.database || decrypted.db || 'postgres'
            const password = decrypted.password || ''
            const ssl = decrypted.ssl === 'require' || decrypted.ssl === 'true' ? '?sslmode=require' : ''
            agentDbConnectionString = `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}${ssl}`
            agent._dbConnectionString = agentDbConnectionString
            agent._dbType = decrypted.dbType || decrypted.db_type || 'postgresql'
            agent._activeDbName = database
            agent._isTrainedModel = false  // connector-scope: NOT a trained model, just DB access
            console.log(`[DB Resolution] Built connection string from connector ${connRows[0].id} (${host}:${port}/${database}, type=${agent._dbType}) — NOT a trained model`)
          }
        } catch (err) {
          console.warn(`[DB Resolution] Connector-scope fallback failed: ${err.message}`)
        }
      }
    }

    // ── SCHEMA PRELOAD (early — before system prompt is built) ─────────
    if (agentDbConnectionString && !agent._schemaPreloaded) {
      try {
        const pg = await import('pg').then(m => m.default || m)
        const client = new pg.Client(agentDbConnectionString)
        await client.connect()
        const { rows: allTables } = await client.query(
          `SELECT table_schema, table_name FROM information_schema.tables
           WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
           ORDER BY table_schema, table_name`
        )
        const tablesToDescribe = allTables.slice(0, 10)
        const tableParts = []
        const fkPairs = []
        for (const t of tablesToDescribe) {
          const { rows: cols } = await client.query(
            `SELECT column_name, data_type FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
            [t.table_schema, t.table_name]
          )
          let fkHints = ''
          try {
            const { rows: fks } = await client.query(
              `SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
               JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
               WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
              [t.table_schema, t.table_name]
            )
            if (fks.length > 0) {
              fkHints = ' → JOINS TO: ' + fks.map(f => `${f.column_name} → ${f.ref_table}(${f.ref_column})`).join(', ')
              for (const fk of fks) fkPairs.push({ fromTable: t.table_name, fromCol: fk.column_name, toTable: fk.ref_table, toCol: fk.ref_column })
            }
          } catch {}
          tableParts.push(`  ${t.table_schema}.${t.table_name} (${cols.map(c => `${c.column_name}:${c.data_type}`).join(', ')})${fkHints}`)
        }
        const joinGuideParts = []
        const byParent = {}
        for (const p of fkPairs) {
          if (!byParent[p.fromTable]) byParent[p.fromTable] = []
          byParent[p.fromTable].push(p)
        }
        for (const [fromTable, pairs] of Object.entries(byParent)) {
          for (const p of pairs) joinGuideParts.push(`  ${fromTable}.${p.fromCol} → ${p.toTable}.${p.toCol}`)
        }
        const joinGuide = joinGuideParts.length > 0
          ? `\n🔗 JOIN GUIDE:\n${joinGuideParts.join('\n')}\n\n⚠️  Always JOIN to resolve names. NEVER show raw IDs.`
          : ''
        await client.end().catch(() => {})
        agent._schemaText = `DATABASE SCHEMA (${allTables.length} tables):\n${tableParts.join('\n')}${joinGuide}`
        agent._schemaPreloaded = true
        console.log(`[Schema Preload] Loaded ${tablesToDescribe.length}/${allTables.length} tables with ${fkPairs.length} FK relationships`)
      } catch (schemaErr) {
        console.warn('[Schema Preload] Failed:', schemaErr.message)
      }
    }

    // 4. Build system prompt — AFTER schema preload so dbRule uses "skip" variant
    const systemPrompt = buildSystemPrompt(agent, skills, task.goal)

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

    // 6. Combined plan + execution — skip the separate planning round-trip.
    // ── Config-driven: DB presence alone determines schema injection.
    // No goal-regex guessing — the agent's system_prompt and tool scopes
    // define what it should do; the hallucination guardrail catches violations.
    const hasDb = !!agentDbConnectionString
    const isTrainedModel = !!agent._isTrainedModel

    // ── Pre-execution capability check: determine what this agent can
    // realistically accomplish. Used to tune priming messages and prevent
    // the model from attempting things it has no tools for. ──
    const hasDataTools = hasDb || toolDefinitions.some(t =>
      t.name === 'http_request' || t.name === 'http_download' ||
      t.name === 'file_search' || t.name === 'browser_use' ||
      t.name.startsWith('local_dir__') ||
      CONNECTOR_TOOL_PREFIXES.some(p => t.name.startsWith(p)) &&
        !['db__', 'database__'].some(dp => t.name.startsWith(dp))
    )
    const isDataTask = /report|analytics|dashboard|top\s+\d+|ranking|list|show|find|query|search|lookup|get|fetch|data|chart|metrics|kpi|insight|visual|trend|analyze|analysis|breakdown/i.test(task.goal)

    // Extract table names from preloaded schema (only when DB exists)
    let schemaTableList = ''
    if (hasDb && agent._schemaPreloaded && agent._schemaText) {
      const tableNames = agent._schemaText
        .split('\n')
        .filter(l => /^\s{2}\w+\.\w+\s*\(/.test(l))
        .map(l => {
          const m = l.match(/^\s{2}(\w+)\.(\w+)\s*\(/)
          return m ? `${m[1]}.${m[2]}` : null
        })
        .filter(Boolean)
      if (tableNames.length > 0) {
        schemaTableList = `\n\n📋 AVAILABLE TABLES (ONLY these exist — do NOT invent names):\n  ${tableNames.join('\n  ')}`
      }
    }

    const schemaSkipHint = (hasDb && agent._schemaPreloaded)
      ? `\n\n⚡ SCHEMA PRELOADED — skip listTables/describeTable, go straight to runQuery with your SQL.`
      : ''

    const dbPriming = hasDb
      ? (isTrainedModel
        ? `\n\nYou have database access. Use runQuery to get real data. Always verify column names against the schema. If a query fails, check the schema and retry.`
        : `\n\nYou have database access via a connector (NOT a trained model). You MAY use runQuery but be CAREFUL — you are a general-purpose model. Only query when you are confident about the schema and column names. If unsure, call describeTable first. Never guess SQL.`)
      : ''

    // ── Capability-aligned guardrail: warn standard models about limitations ──
    const capabilityNote = (!hasDataTools && isDataTask)
      ? `\n⚠️  NOTE: This task asks for data but you have NO database, HTTP, or file access configured. You cannot retrieve real data. Be honest — state that you lack the necessary data tools and suggest what connectors would help (database, REST API, local directory). Do NOT fabricate data or pretend you ran queries.`
      : ''

    // ── Anti-hallucination priming ──
    // When the agent has a preloaded schema, it can skip discovery and go
    // straight to querying. Otherwise, encourage light discovery first.
    const antiHallucination = (hasDb && agent._schemaPreloaded)
      ? `\n\n🎯 You have the full schema above. Think about what query you need, then call runQuery. Do NOT call listTables or describeTable — the schema is already loaded.`
      : (hasDb
        ? `\n\n🎯 You have database access. Think about what tables you need, call describeTable on them, then runQuery.`
        : `\n\n🎯 Think step by step about how to achieve the goal, then call the most appropriate tool.`)

    const execMessages = [
      ...messages,
      { role: 'user', content: `Work on the task step by step.${schemaTableList}${schemaSkipHint}${dbPriming}${capabilityNote}${antiHallucination}` }
    ]
    // Store a placeholder plan (old UI expects it)
    await query(`UPDATE agent_tasks SET plan = $1 WHERE id = $2 AND tenant_id = $3`, [{ steps: 'Execution plan combined with first action' }, task.id, tenantId])

    // toolDefinitions already declared above (after skills load) — do not re-declare here.

    // ══════════════════════════════════════════════════════════════════════════
    // Agent Tool Scoping — resolve which connectors / MCPs / built-ins this
    // agent is allowed to use. Without explicit scopes, ONLY custom skills
    // and immutable built-ins (http_request, a2a_call, browser_use,
    // publish_dashboard_report, delegate_task) are available.
    // ══════════════════════════════════════════════════════════════════════════
    const scopes = await resolveAgentScopes(agent.tenant_id, agent.id)

    // Load MCP server tools — filtered by agent scopes
    try {
      const mcpServers = await getTenantMcpServers(agent.tenant_id)
      for (const server of mcpServers) {
        // Skip if this MCP server is not in allowed scopes (unless explicitly allowed)
        if (scopes.allowedMcpServers.size > 0 && !scopes.allowedMcpServers.has(server.id)) continue
        // Skip if explicitly denied
        if (scopes.deniedMcpServers.has(server.id)) continue

        const mcpTools = await listMcpTools(server)
        for (const tool of mcpTools) {
          const uniqueName = `mcp__${server.id.replace(/-/g, '_')}__${tool.name}`
          const needsApproval = scopes.approvalMcpServers.has(server.id)
          toolDefinitions.push({
            name: uniqueName,
            description: `[MCP: ${server.name}]${needsApproval ? ' [REQUIRES APPROVAL]' : ''} ${tool.description || ''}`,
            inputSchema: tool.inputSchema || { type: 'object', properties: {} }
          })
        }
      }
    } catch (err) {
      // Non-critical: MCP tools optional
    }

    // ── 2nd-pass DB resolution removed — the 1st pass (above, ~L473) is
    // the single source of truth. agent._dbConnectionString is set there
    // and all subsequent code reads from it. Duplicate resolution blocks
    // caused connection mismatches when the agent had a connector-scope DB
    // but the 2nd pass picked a different (trained) model connection instead.

    // ── Inject preloaded schema into execMessages (already loaded above) ──
    if (agent._schemaPreloaded && agent._schemaText) {
      execMessages.splice(1, 0, {
        role: 'user',
        content: `⚡ SCHEMA PRELOADED — full table list + columns + foreign keys below.\n\n${agent._schemaText}\n\nYou can skip listTables/describeTable — go straight to runQuery.`
      })
      console.log('[Schema Preload] Injected schema into execMessages')
    }

    // Load configured connector tools (Slack, Jira, GitHub, Gmail, Webhook, …)
    // Only ACTIVE connectors surface as tools, filtered by agent scopes.
    try {
      const connectorDefs = await getConnectorToolDefinitions(agent.tenant_id)
      for (const def of connectorDefs) {
        // Extract connector ID from the def (stored as def._connectorId by getConnectorToolDefinitions)
        const connId = def._connectorId

        // If agent has explicit connector scopes, only include allowed ones
        if (scopes.allowedConnectors.size > 0 && connId && !scopes.allowedConnectors.has(connId)) continue
        // If agent has group scopes, check if this connector belongs to an allowed group
        if (scopes.allowedConnectors.size === 0 && scopes.allowedGroups.size > 0 && connId) {
          continue
        }
        // Skip if explicitly denied
        if (connId && scopes.deniedConnectors.has(connId)) continue

        // ══════════════════════════════════════════════════════════════════════
        // IMPORTANT: Always skip connector DB tools (db__*). They are legacy
        // wrappers that confuse small models — the lightweight listTables /
        // describeTable / runQuery tools (injected below) are the only correct
        // path for database access. Connector DB tools also have broken
        // credentials and parameter mismatches (e.g. "query" vs "sql").
        // ══════════════════════════════════════════════════════════════════════
        if (def.name && def.name.startsWith('db__')) {
          console.log(`[Tools] Skipping connector DB tool: ${def.name}`)
          continue
        }

        // Mark readonly connectors
        if (connId && scopes.readonlyConnectors.has(connId)) {
          def.description = `[READ ONLY] ${def.description || ''}`
        }

        toolDefinitions.push(def)
      }
    } catch (err) {
      // Non-critical: connector tools are optional
    }

    // ── Database-trained model tools ─────────────────────────────────────────
    // Inject lightweight DB tools (listTables/describeTable/runQuery)
    // + listDatabases/useDatabase for multi-DB models
    if (agentDbConnectionString) {
      let { rows: [customModel] } = await query(
        `SELECT model_name FROM custom_models
         WHERE tenant_id = $1 AND (model_name = $2
                OR model_name = split_part($2, ':', 1))
         LIMIT 1`,
        [agent.tenant_id, agent.llm_model]
      )
      // Fallback: if the agent's model didn't match, pick any completed DB model
      if (!customModel) {
        const { rows: [fallback] } = await query(
          `SELECT model_name FROM custom_models
           WHERE tenant_id = $1
             AND data_source = 'database'
             AND status = 'COMPLETED'
             AND db_connection_string IS NOT NULL
             AND db_connection_string != ''
           ORDER BY updated_at DESC LIMIT 1`,
          [agent.tenant_id]
        )
        customModel = fallback
      }
      const dbModelName = customModel?.model_name || 'database'

      // ── Multi-DB tools (prepended when connection map exists) ───────────
      if (agentDbConnectionMap) {
        const dbLabels = [...agentDbConnectionMap.keys()].join(', ')
        toolDefinitions.push({
          name: 'listDatabases',
          description: `[DB: ${dbModelName}] List all available databases in this multi-database setup. Available: ${dbLabels}. Call this FIRST to see which data sources are accessible.`,
          inputSchema: { type: 'object', properties: {} }
        })
        toolDefinitions.push({
          name: 'useDatabase',
          description: `[DB: ${dbModelName}] Switch the active database connection. Available labels: ${dbLabels}. Call this before querying a specific database. Once switched, all subsequent listTables/describeTable/runQuery calls target that database.`,
          inputSchema: {
            type: 'object', required: ['database'],
            properties: {
              database: { type: 'string', description: `Database label to switch to. Available: ${dbLabels}` },
            }
          }
        })
      }

      // Only inject listTables when schema was NOT preloaded.
      // When preloaded the agent already has the full table list.
      if (!agent._schemaPreloaded) {
        toolDefinitions.push({
          name: 'listTables',
          description: `[DB: ${dbModelName}] List all tables in the currently active database. Use this first to see what data is available.`,
          inputSchema: { type: 'object', properties: {} }
        })
      }
      toolDefinitions.push({
        name: 'describeTable',
        description: `[DB: ${dbModelName}] Get column details, foreign keys, and sample rows for a specific table. Call this before writing any query to understand the schema.`,
        inputSchema: {
          type: 'object', required: ['table'],
          properties: {
            table: { type: 'string', description: 'Table name' },
            schema: { type: 'string', description: 'Schema name (default: public)' },
          }
        }
      })
      toolDefinitions.push({
        name: 'runQuery',
        description: `[DB: ${dbModelName}] Run a SQL SELECT query against the live database. Only SELECT queries are allowed. ⚠️ CRITICAL: You MUST call listTables AND describeTable BEFORE this tool. Never guess table or column names — use only names confirmed by describeTable. Use the "sql" parameter (NOT "query") to pass your query. If this tool returns an error, DO NOT fabricate data — report the error honestly and retry with corrected SQL. Never delegate to another agent — you have all the tools you need.`,
        inputSchema: {
          type: 'object', required: ['sql'],
          properties: {
            sql: { type: 'string', description: 'SQL SELECT query to execute (use "sql", NOT "query")' },
            query: { type: 'string', description: 'Alias for sql — use "sql" instead' },
          }
        }
      })
    }

    // ── Knowledge Graph search tool ─────────────────────────────────────────
    // If the agent has knowledge-graph connectors scoped, give it a runtime
    // searchGraph tool so it can search entities/relationships on demand
    // (not just once at task start via retrieveKnowledge).
    const hasGraphConnectors = await (async () => {
      try {
        const { getAgentGraphConnectors } = await import('./graph-knowledge.service.js')
        const gcs = await getAgentGraphConnectors(agent.id, agent.tenant_id)
        return gcs.length > 0
      } catch { return false }
    })()
    if (hasGraphConnectors) {
      toolDefinitions.push({
        name: 'searchGraph',
        description: 'Search the knowledge graph for entities and relationships matching a keyword or concept. Returns entities (names, types) and their relationships (edges). Use this to discover how entities are connected — e.g. "which customers are linked to order #1234" or "find all suppliers for product X". Call this BEFORE writing SQL queries that join across entities, so you understand the data model.',
        inputSchema: {
          type: 'object', required: ['query'],
          properties: {
            query: { type: 'string', description: 'Search term or concept to find in the knowledge graph (e.g. "Acme Corp", "order 12345", "supplier")' },
          }
        }
      })
    }

    // ── ALWAYS-AVAILABLE built-ins ─────────────────────────────────────────
    // These are the core tools every agent needs to function. They can only be
    // removed via an explicit 'denied' scope entry.

    // HTTP tool (default: allowed)
    if (!scopes.deniedBuiltins.has('http_request')) {
      toolDefinitions.push({
        name: 'http_request',
        description: scopes.approvalBuiltins.has('http_request')
          ? '[REQUIRES APPROVAL] Make an HTTP request to any URL'
          : 'Make an HTTP request to any URL',
        inputSchema: {
          type: 'object', required: ['url', 'method'],
          properties: {
            url: { type: 'string' }, method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
            body: { type: 'object' }, headers: { type: 'object' }
          }
        }
      })
    }

    // A2A — call an external agent by URL (default: allowed)
    if (!scopes.deniedBuiltins.has('a2a_call')) {
      toolDefinitions.push({
        name: 'a2a_call',
        description: 'Delegate a subtask to another AI agent (external) via the A2A protocol. Use this to collaborate with specialised agents outside your system.',
        inputSchema: {
          type: 'object', required: ['agentUrl', 'goal'],
          properties: {
            agentUrl: { type: 'string', description: 'The A2A agent base URL (e.g. https://other-system.com/a2a/agents/xyz)' },
            goal: { type: 'string', description: 'The task goal to delegate' }
          }
        }
      })
    }

    // --- Phase 3: CrewAI-style Internal Delegation ---
    if (!scopes.deniedBuiltins.has('delegate_task')) {
      try {
        const { rows: otherAgents } = await query(
          `SELECT id, name, description FROM agents WHERE tenant_id = $1 AND status = 'ACTIVE' AND id != $2`,
          [agent.tenant_id, agent.id]
        )
        
        if (otherAgents.length > 0) {
          const agentListString = otherAgents.map(a => `- ID: ${a.id} | Name: ${a.name} | Desc: ${a.description}`).join('\n')
          toolDefinitions.push({
            name: 'delegate_task',
            description: `Delegate a sub-task to another specialized agent in your team. Wait for their response. Available agents:\n${agentListString}`,
            inputSchema: {
              type: 'object', required: ['target_agent_id', 'goal'],
              properties: {
                target_agent_id: { type: 'string', description: 'The exact ID of the agent to delegate to (from the list above)' },
                goal: { type: 'string', description: 'The specific task goal to delegate to this worker agent' }
              }
            }
          })
        }
      } catch (err) {
        // Non-critical: internal delegation is optional
      }
    }

    // Browser control tool (default: allowed)
    if (!scopes.deniedBuiltins.has('browser_use')) {
      toolDefinitions.push({
        name: 'browser_use',
        description: scopes.approvalBuiltins.has('browser_use')
          ? '[REQUIRES APPROVAL] Control a real web browser: navigate to URLs, click elements, fill forms, and extract page content.'
          : 'Control a real web browser: navigate to URLs, click elements, fill forms, and extract page content. Use this to interact with websites that have no API.',
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
    }

    // Report publishing tool (default: allowed)
    // ════════════════════════════════════════════════════════════════════════
    // IMPORTANT: publish_dashboard_report is NOT added to the tool list at
    // startup when a DB connection is active. It is injected AFTER the first
    // successful runQuery completes. This prevents small models from calling
    // publish with fabricated/hallucinated data before querying the database.
    // ════════════════════════════════════════════════════════════════════════
    const publishDenied = scopes.deniedBuiltins.has('publish_dashboard_report')
    const publishToolDef = publishDenied ? null : {
      name: 'publish_dashboard_report',
      description: `Publishes a rich, styled report to the Kuvalam dashboard. Pick the format that best fits the GOAL and the DATA you collected:

1. CHART (tabular/SQL data): { title, output_format: "chart", df: [row objects], charts: [{ type:"bar"|"line"|"pie"|"doughnut"|"scatter"|"radar", title, x_key, y_key, y_keys? }], kpis: [{ label, value, icon?, trend?, trendLabel? }], summary, table_title? }. Auto-builds KPI cards, Chart.js charts, and a sortable data table. Use y_keys (array) for multi-series charts.

2. SVG (diagrams/schematics): { title, output_format: "svg", svg_content: "<svg>...</svg>" }. Renders vector graphics inline. Ideal for beam diagrams, ECG traces, floor plans, anatomical drawings, circuit diagrams, stress/strain plots, flowcharts. IMPORTANT: Use viewBox="0 0 800 600" (or larger) on the <svg> tag so the diagram scales properly. Generate a COMPLETE, detailed diagram — not a placeholder. Include all necessary elements: labels, dimensions, axes, legend, annotations, color coding. Do NOT output tiny or empty SVGs.

3. HTML (full control): { title, output_format: "html", html_content: "..." }. Complete creative freedom with inline CSS. Use Chart.js CDN for charts, or any custom layout.

4. D3 (interactive): { title, output_format: "d3", d3_script: "...", d3_data: {...}, d3_title? }. For force-directed graphs, sankey diagrams, geo maps, custom interactive visualizations.

5. MIXED (multi-section): { title, output_format: "mixed", sections: [{ format: "svg"|"chart"|"html"|"d3"|"text", title, ... }] }. Combine multiple formats in one report.

CHOOSE WISELY: Use "chart" when you ran SQL and have tabular rows. Use "svg" when the goal asks for a diagram/drawing. Use "html" when you need layout beyond what chart/svg provide. Use "d3" for network/geo/force data. Use "mixed" when one format isn't enough.`,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Report title (required)' },
          output_format: { type: 'string', enum: ['chart', 'svg', 'd3', 'html', 'mixed'], description: 'Output format. "chart" for structured data with Chart.js, "svg" for vector diagrams, "d3" for interactive D3.js, "html" for raw HTML, "mixed" for multi-section.' },
          html_content: { type: 'string', description: 'Full HTML report. Use only with output_format: "html".' },
          svg_content: { type: 'string', description: 'Raw SVG markup. Use with output_format: "svg".' },
          d3_script: { type: 'string', description: 'D3.js JavaScript code. Use with output_format: "d3".' },
          d3_data: { description: 'Data object for D3 visualizations.' },
          d3_title: { type: 'string', description: 'Title for the D3 chart section.' },
          sections: { description: 'Array of sections for output_format: "mixed". Each section has { format, title?, content? }.' },
          df: { description: 'Array of row objects. Use with output_format: "chart".' },
          charts: { description: 'Array of chart configs.' },
          kpis: { description: 'Array of KPI cards.' },
          summary: { type: 'string', description: 'Summary paragraph.' },
          table_title: { type: 'string', description: 'Custom table heading.' }
        },
        required: ['title']
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 9 WEAPONS — New built-in tools for next-gen execution
    // ════════════════════════════════════════════════════════════════════════

    // http_download — fetch a file from a URL and return its contents
    if (!scopes.deniedBuiltins.has('http_download')) {
      toolDefinitions.push({
        name: 'http_download',
        description: scopes.approvalBuiltins.has('http_download')
          ? '[REQUIRES APPROVAL] Download a file from a URL and return its contents as text (max 5MB). Use this to fetch documents, data files, or web resources.'
          : 'Download a file from a URL and return its contents as text (max 5MB). Use this to fetch documents, data files, or web resources.',
        inputSchema: {
          type: 'object', required: ['url'],
          properties: {
            url: { type: 'string', description: 'The URL to download from' },
            encoding: { type: 'string', enum: ['text', 'base64', 'json'], default: 'text', description: 'How to return the content' }
          }
        }
      })
    }

    // file_search — search file contents on the local filesystem using grep/find
    if (!scopes.deniedBuiltins.has('file_search')) {
      toolDefinitions.push({
        name: 'file_search',
        description: 'Search file contents on the local filesystem using ripgrep or grep. Great for finding code, configs, logs, or data files by content pattern.',
        inputSchema: {
          type: 'object', required: ['pattern'],
          properties: {
            pattern: { type: 'string', description: 'The search pattern (regex or plain text)' },
            path: { type: 'string', description: 'Directory to search (default: current workspace root)' },
            filePattern: { type: 'string', description: 'Glob pattern to filter files, e.g. "*.js", "*.log", "*.md"' },
            maxResults: { type: 'integer', default: 20, description: 'Maximum number of matches to return' },
            caseSensitive: { type: 'boolean', default: false }
          }
        }
      })
    }

    // write_artifact — persist output files (SVG, CSV, JSON, PNG, HTML, PDF, ZIP folders)
    if (!scopes.deniedBuiltins.has('write_artifact')) {
      toolDefinitions.push({
        name: 'write_artifact',
        description: `Persist a file or folder of files and get a download URL. Essential for creating SVG diagrams, CSVs, JSON, PNG images, PDFs, or ZIP archives of multiple files. The returned download_url can be shared or referenced in reports.

FORMATS & USE CASES:
- "svg": Vector diagrams, engineering drawings, medical charts, floor plans, electrical schematics, beam deflection plots
- "csv": Data exports, spreadsheets, tabular results
- "png": Screenshots, rendered images (provide base64 content)
- "pdf": Downloadable reports, documents
- "json": Structured data exports
- "html": Standalone interactive pages
- "zip": Multi-file folder bundles — pass files: [{ path: "data.csv", content: "..." }, { path: "chart.svg", content: "..." }]`,
        inputSchema: {
          type: 'object', required: ['format'],
          properties: {
            format: { type: 'string', enum: ['svg', 'csv', 'json', 'png', 'pdf', 'html', 'zip'], description: 'Output format' },
            filename: { type: 'string', description: 'Desired filename (auto-generated if omitted)' },
            content: { type: 'string', description: 'File content (for svg/csv/json/html: raw text; for png: base64; for pdf: HTML string that gets converted). Required for non-zip.' },
            files: { description: 'For zip format only: array of { path: "subfolder/name.ext", content: "..." } objects' },
          }
        }
      })
    }

    // docker_run — run a command in a Docker container
    if (!scopes.deniedBuiltins.has('docker_run')) {
      toolDefinitions.push({
        name: 'docker_run',
        description: 'Run a command in a Docker container (uses `docker run --rm`). Great for isolated execution of untrusted code, running tools not installed on the host, or spinning up temporary services.',
        inputSchema: {
          type: 'object', required: ['image', 'command'],
          properties: {
            image: { type: 'string', description: 'Docker image to use (e.g. "python:3.12", "alpine:latest")' },
            command: { type: 'string', description: 'Command to run inside the container' },
            workdir: { type: 'string', description: 'Working directory inside the container' },
            mount: { type: 'string', description: 'Mount a local directory as volume (e.g. "/host/path:/container/path")' },
            env: { type: 'object', description: 'Environment variables to set inside the container' },
            timeout: { type: 'integer', default: 30, description: 'Timeout in seconds (max 120)' }
          }
        }
      })
    }

    // ssh_exec — execute a command on a remote machine via SSH
    if (!scopes.deniedBuiltins.has('ssh_exec')) {
      toolDefinitions.push({
        name: 'ssh_exec',
        description: 'Execute a command on a remote machine via SSH. Requires SSH key-based auth configured in the integration. Use this to manage remote servers, run deployments, or gather system info.',
        inputSchema: {
          type: 'object', required: ['host', 'command'],
          properties: {
            host: { type: 'string', description: 'Remote hostname or IP address' },
            command: { type: 'string', description: 'Command to execute on the remote host' },
            port: { type: 'integer', default: 22, description: 'SSH port' },
            user: { type: 'string', default: 'root', description: 'SSH user' },
            timeout: { type: 'integer', default: 30, description: 'Timeout in seconds (max 120)' }
          }
        }
      })
    }

    // create_connector — provision a new connector on-the-fly and auto-enable it
    // for this agent. Essential when the agent needs a local directory, REST API,
    // webhook, or shell that doesn't exist yet in the tenant config.
    if (!scopes.deniedBuiltins.has('create_connector')) {
      toolDefinitions.push({
        name: 'create_connector',
        description: `Create and enable a new connector on-the-fly. Use this when you need access to a resource (local directory, REST API, webhook, shell) that hasn't been pre-configured. The connector is immediately available to you after creation.

SUPPORTED TYPES:
- "local-dir": Mount a local filesystem directory. Required config: { path: "/absolute/path" }
- "local-shell": Execute shell commands on the host. Required config: { shell: "bash" } (default: bash)
- "rest": Generic REST API endpoint. Required config: { baseUrl: "https://..." }, optional: { headers: {...}, auth_type: "API_KEY"|"NONE", apiKey: "..." }
- "webhook": Incoming webhook endpoint. Required config: { url: "https://..." }`,
        inputSchema: {
          type: 'object', required: ['tool_id', 'name'],
          properties: {
            tool_id: { type: 'string', enum: ['local-dir', 'local-shell', 'rest', 'webhook'], description: 'Type of connector to create' },
            name: { type: 'string', description: 'Human-readable name, e.g. "Project Data Directory"' },
            config: { type: 'object', description: 'Connector-specific configuration (see description above for required fields)' }
          }
        }
      })
    }

    // create_trigger — set up recurring execution for this agent. Creates a
    // single-step AGENT workflow with a SCHEDULE or WEBHOOK trigger so the
    // agent runs automatically on a cron schedule or external event.
    if (!scopes.deniedBuiltins.has('create_trigger')) {
      toolDefinitions.push({
        name: 'create_trigger',
        description: `Set up recurring execution for this agent. Creates a workflow that runs the given goal on a schedule (cron) or via webhook. The scheduler picks it up immediately.

SUPPORTED TYPES:
- "SCHEDULE": Run on a cron schedule. Config requires { cron: "..." } using standard 5-field cron (minute hour dom month dow). Examples:
  · "0 8 * * *" — every day at 8 AM
  · "0 9 * * 1-5" — weekdays at 9 AM
  · "0 */2 * * *" — every 2 hours
  · "30 8 * * 1" — every Monday at 8:30 AM
- "WEBHOOK": Triggered by an external HTTP POST. Config must include { secret: "..." } (auto-generated if omitted).`,
        inputSchema: {
          type: 'object', required: ['trigger_type', 'goal'],
          properties: {
            trigger_type: { type: 'string', enum: ['SCHEDULE', 'WEBHOOK'], description: 'How this trigger fires' },
            name: { type: 'string', description: 'Optional name for the scheduled job. Auto-generated from goal if omitted.' },
            goal: { type: 'string', description: 'The task goal to execute on each trigger fire' },
            config: { type: 'object', description: 'Trigger-specific config: { cron: "..." } for SCHEDULE, { secret: "..." } for WEBHOOK' }
          }
        }
      })
    }

    // create_agent — on-the-fly agent provisioning. Creates a new agent under
    // the same tenant so the orchestrator can delegate specialized work.
    if (!scopes.deniedBuiltins.has('create_agent')) {
      toolDefinitions.push({
        name: 'create_agent',
        description: `Create a new agent under this tenant. Use this when you need a specialized agent for a sub-task (e.g., a data analyst, a notifier, a web scraper). The agent is immediately ready for delegation via delegate_task or can be used in workflows.

ARCHEYPES (pick the best fit):
- "analytics" — data analysis, SQL, reporting, dashboards
- "coordinator" — orchestration, automation, scheduling
- "communication" — notifications, messaging, email/Slack/Discord
- "compliance" — audits, security scans, policy checks
- "planner" — project management, task breakdown
- "research" — investigation, web research, synthesis
- "document" — writing, content generation, summarization

AUTONOMY LEVELS: SUPERVISED (asks before each action), GUARDED (low-risk autonomous), AUTONOMOUS (full auto for cron/background).`,
        inputSchema: {
          type: 'object', required: ['name'],
          properties: {
            name: { type: 'string', description: 'Short memorable name, e.g. "Daily Sales Reporter"' },
            description: { type: 'string', description: 'One-line summary of what this agent does' },
            archetype: { type: 'string', enum: ['planner', 'research', 'compliance', 'document', 'communication', 'analytics', 'coordinator'], description: 'Agent role archetype' },
            autonomyLevel: { type: 'string', enum: ['SUPERVISED', 'GUARDED', 'AUTONOMOUS'], description: 'How freely the agent can act', default: 'SUPERVISED' },
            systemPrompt: { type: 'string', description: 'Custom system prompt. If omitted, a sensible default is used.' },
            llmModel: { type: 'string', description: 'LLM model override. If omitted, uses tenant default.' }
          }
        }
      })
    }

    // create_workflow — build multi-step integration pipelines with AGENT,
    // TOOL, HTTP, CONDITION, APPROVAL, NOTIFY, TRANSFORM, DELAY, PARALLEL,
    // LOOP, CREW, DB, and WAIT steps.
    if (!scopes.deniedBuiltins.has('create_workflow')) {
      toolDefinitions.push({
        name: 'create_workflow',
        description: `Build a multi-step automation workflow. Combine agent tasks, tool calls, conditions, notifications, and more into a DAG (directed acyclic graph). The workflow can be triggered manually, on a schedule (via create_trigger), or by a webhook.

STEP TYPES (each needs { id, type, input }):
1. AGENT — { goal: "..." } — run an AI agent
2. TOOL — { tool: "tool_name", args: {...} } — execute a connector tool
3. HTTP — { method: "GET|POST|PUT|DELETE", url: "https://...", headers?: {...}, body?: "..." }
4. NOTIFY — { provider: "slack|gmail|discord|sendgrid|twilio", channel: "...", message: "..." }
5. CONDITION — has "routes": [{ when: "expr", goto: "step_id" }, { goto: "step_id" }] — last route is default
6. APPROVAL — { message?: "approval reason" } — human-in-the-loop
7. TRANSFORM — { template: { field: "{{expr}}" } } — reshape data
8. DELAY — { seconds: number } — pause execution
9. PARALLEL — { tasks: [{ id, type, input }] } — run tasks concurrently
10. LOOP — { over: "{{arrayExpr}}", as: "item", steps: [...] }
11. CREW — { agents: [{ name, goal }], strategy: "sequential|parallel" }
12. DB — { sql: "...", connectionId?: "..." }

Reference previous step outputs with: {{stepId.fieldName}}`,
        inputSchema: {
          type: 'object', required: ['name', 'steps'],
          properties: {
            name: { type: 'string', description: 'Workflow name, e.g. "Daily Sales Pipeline"' },
            description: { type: 'string', description: 'What this workflow accomplishes' },
            steps: { type: 'array', description: 'Array of step objects forming the DAG', items: { type: 'object' } },
            activate: { type: 'boolean', description: 'Set to true to activate immediately (default: false = DRAFT)', default: false }
          }
        }
      })
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PRE-EXECUTION AGENT CONTEXT CHECK
    // Build a complete profile of this agent's CONNECTIONS — databases, MCP
    // servers, connectors, knowledge bases — and inject it into execMessages
    // so the LLM knows its own capabilities BEFORE it starts calling tools.
    // Handles agents with multiple database connections (all are listed).
    // ════════════════════════════════════════════════════════════════════════════

    // 1. Ping the active DB (the one resolved for execution) to validate reachability
    let activeDbStatus = 'not checked'
    let activeDbName = ''
    if (hasDb) {
      try {
        const pg = await import('pg').then(m => m.default || m)
        const testClient = new pg.Client({
          connectionString: agentDbConnectionString,
          statement_timeout: 5000,
          query_timeout: 5000,
          connectionTimeoutMillis: 5000,
        })
        await testClient.connect()
        const { rows: [row] } = await testClient.query(
          `SELECT current_database() AS db, current_user AS usr, version() AS ver`
        )
        await testClient.end()
        activeDbName = row.db
        agent._activeDbName = row.db   // persist for buildSystemPrompt DB type injection
        activeDbStatus = `reachable (pg=${row.ver?.split(',')[0] || '?'})`
        console.log(`[Agent Context] ✅ Active DB validated: ${row.db}@${row.ver?.slice(0, 40)}`)
      } catch (e) {
        activeDbStatus = `UNREACHABLE — ${e.message.slice(0, 100)}`
        console.warn(`[Agent Context] ❌ Active DB connection FAILED: ${e.message}`)
      }
    }

    // 2. Integration inventory — categorize every tool available to this agent
    const dbToolNames = ['listTables', 'listDatabases', 'useDatabase', 'describeTable', 'runQuery']
    const builtinToolNames = ['http_request', 'http_download', 'a2a_call', 'delegate_task',
      'browser_use', 'file_search', 'write_artifact', 'publish_dashboard_report',
      'docker_run', 'ssh_exec', 'create_connector', 'create_workflow']
    const hasDbTools = toolDefinitions.some(t => dbToolNames.includes(t.name))
    const hasHttp = toolDefinitions.some(t => t.name === 'http_request' || t.name === 'http_download')
    const hasBrowser = toolDefinitions.some(t => t.name === 'browser_use')
    const hasPublish = toolDefinitions.some(t => t.name === 'publish_dashboard_report')
    const connectorToolNames = toolDefinitions
      .filter(t => CONNECTOR_TOOL_PREFIXES.some(p => t.name.startsWith(p)) &&
        !['db__', 'database__'].some(dp => t.name.startsWith(dp)))
      .map(t => t.name)
    const connectorToolCount = connectorToolNames.length
    const mcpToolNames = toolDefinitions.filter(t => t.name.startsWith('mcp__')).map(t => t.name)
    const mcpToolCount = mcpToolNames.length
    const customSkillCount = toolDefinitions.filter(t =>
      !dbToolNames.includes(t.name) &&
      !builtinToolNames.includes(t.name) &&
      !CONNECTOR_TOOL_PREFIXES.some(p => t.name.startsWith(p)) &&
      !t.name.startsWith('mcp__')
    ).length

    // 3. Query ALL tool_connections scoped to this agent — database + non-database
    //    An agent can have MULTIPLE database connections. Collect them all.
    const allDbConnections = []   // { name, tool_id }
    const connectorConnections = [] // non-DB connectors (Slack, Jira, etc.)
    try {
      const { rows: scopeRows } = await query(
        `SELECT tc.name, tc.tool_id
         FROM agent_tool_scopes ats
         JOIN tool_connections tc ON ats.connector_id = tc.id
         WHERE ats.agent_id = $1 AND ats.scope_type = 'connector'
           AND tc.status = 'ACTIVE'
         ORDER BY tc.tool_id, tc.name`,
        [agent.id]
      )
      for (const row of scopeRows) {
        if (row.tool_id === 'database' || row.tool_id === 'postgres') {
          allDbConnections.push({ name: row.name, tool_id: row.tool_id })
        } else {
          connectorConnections.push(`${row.name} (${row.tool_id})`)
        }
      }
    } catch (e) {
      console.warn(`[Agent Context] Could not query tool_connections: ${e.message}`)
    }

    // 4. Query knowledge bases linked to this agent
    const knowledgeBaseNames = []
    try {
      const { rows: kbRows } = await query(
        `SELECT kb.name
         FROM agent_knowledge_bases akb
         JOIN knowledge_bases kb ON akb.knowledge_base_id = kb.id
         WHERE akb.agent_id = $1`,
        [agent.id]
      )
      for (const row of kbRows) knowledgeBaseNames.push(row.name)
    } catch { /* non-critical */ }

    // 5. MCP server summary
    let mcpBlock = ''
    if (mcpToolCount > 0) {
      const mcpServers = new Set()
      for (const name of mcpToolNames) {
        const parts = name.split('__')
        if (parts.length >= 2) mcpServers.add(parts[1].replace(/_/g, '-'))
      }
      mcpBlock = `\nMCP: ${[...mcpServers].join(', ')} (${mcpToolCount} tools)`
    }

    // 6. Connector summary (from actual connections, not just tool defs)
    let connectorBlock = ''
    if (connectorConnections.length > 0) {
      connectorBlock = `\nConnectors: ${connectorConnections.join(', ')}`
    } else if (connectorToolCount > 0) {
      // Fallback: connector tools exist but no scoped connections found
      connectorBlock = `\nConnectors: ${connectorToolNames.slice(0, 6).join(', ')}${connectorToolNames.length > 6 ? ` +${connectorToolNames.length - 6} more` : ''}`
    }

    // 7. Knowledge base block
    let knowledgeBlock = ''
    if (knowledgeBaseNames.length > 0) {
      knowledgeBlock = `\nKnowledge: ${knowledgeBaseNames.join(', ')}`
    }

    // 8. Build the profile summary (for console logging)
    const dbSummary = allDbConnections.length > 0
      ? allDbConnections.map(d => `${d.name}${d.name === activeDbName || allDbConnections.length === 1 ? ' ⬅ active' : ''}`).join(', ')
      : (hasDbTools ? 'postgres' : 'none')
    const profile = [
      `Agent: ${agent.name} (${(agent.id || '').slice(0, 8)}...)`,
      `Model: ${agent.llm_model} (${isTrainedModel ? 'TRAINED custom model' : 'STANDARD general-purpose'})`,
      `Databases: ${allDbConnections.length} scoped (active: ${activeDbName || 'none'} — ${activeDbStatus})`,
      `  All: ${dbSummary}`,
      `Connections:`,
      `  HTTP/web:  ${hasHttp ? '✅ http_request' : '❌ none'}`,
      `  Browser:   ${hasBrowser ? '✅ browser_use' : '❌ none'}`,
      `  Connectors: ${connectorConnections.length > 0 ? `✅ ${connectorConnections.join(', ')}` : connectorToolCount > 0 ? `✅ ${connectorToolCount} tool(s)` : '❌ none'}`,
      `  MCPs:      ${mcpToolCount > 0 ? `✅ ${mcpToolCount} tool(s)` : '❌ none'}`,
      `  Knowledge: ${knowledgeBaseNames.length > 0 ? `✅ ${knowledgeBaseNames.join(', ')}` : '❌ none'}`,
      `  Publish:   ${hasPublish ? '✅ publish_dashboard_report' : '❌ none'}`,
      `  Custom:    ${customSkillCount > 0 ? `✅ ${customSkillCount} skill(s)` : '❌ none'}`,
      `Total tools: ${toolDefinitions.length}`,
    ].join('\n')

    console.log(`[Agent Context]\n${profile}`)

    // Store profile for result metadata and debugging
    agent._agentProfile = profile
    agent._agentExecContext = {
      isTrainedModel,
      hasDb,
      activeDbName,
      activeDbStatus,
      allDbConnections: allDbConnections.map(d => d.name),
      toolCount: toolDefinitions.length,
      hasDbTools,
      hasHttp,
      hasBrowser,
      hasPublish,
      connectorToolCount,
      mcpToolCount,
      customSkillCount,
      knowledgeBaseNames,
    }

    // 8b. Build a categorized AVAILABLE TOOLS list from toolDefinitions
    // This gives small models a plain-text catalog of what they can call
    // BEFORE they start thinking, preventing hallucinated tool names.
    const dataToolNames = toolDefinitions
      .filter(t => ['runQuery','listTables','describeTable','listDatabases','useDatabase'].includes(t.name))
      .map(t => t.name)
    const webToolNames = toolDefinitions
      .filter(t => ['http_request','http_download','browser_use'].includes(t.name))
      .map(t => t.name)
    const fileToolNames = toolDefinitions
      .filter(t => ['file_search','write_artifact','local_dir__list','local_dir__read','local_dir__write'].includes(t.name) || t.name.startsWith('local_dir__') || t.name.startsWith('local_file__'))
      .map(t => t.name)
    const shellToolNames = toolDefinitions
      .filter(t => ['docker_run','ssh_exec','local_shell__execute'].includes(t.name) || t.name.startsWith('local_shell__'))
      .map(t => t.name)
    const delegateToolNames = toolDefinitions
      .filter(t => ['delegate_task','a2a_call','create_agent','create_workflow','create_trigger','create_connector'].includes(t.name))
      .map(t => t.name)
    const publishToolNames = toolDefinitions
      .filter(t => ['publish_dashboard_report'].includes(t.name))
      .map(t => t.name)
    const connectorToolShortNames = toolDefinitions
      .filter(t => CONNECTOR_TOOL_PREFIXES.some(p => t.name.startsWith(p)) &&
        !['db__','database__'].some(dp => t.name.startsWith(dp)))
      .map(t => t.name.replace(/__/g, ' → '))

    const toolsSection = [
      `── YOUR TOOLS (call these — do NOT hallucinate) ──`,
      dataToolNames.length > 0 ? `📊 Data: ${dataToolNames.join(', ')}` : '',
      webToolNames.length > 0 ? `🌐 Web: ${webToolNames.join(', ')}` : '',
      fileToolNames.length > 0 ? `📁 Files: ${fileToolNames.join(', ')}` : '',
      shellToolNames.length > 0 ? `💻 Shell: ${shellToolNames.join(', ')}` : '',
      publishToolNames.length > 0 ? `📄 Publish: ${publishToolNames.join(', ')}` : '',
      connectorToolShortNames.length > 0 ? `🔌 Connectors: ${connectorToolShortNames.join(', ')}` : '',
      mcpToolNames.length > 0 ? `🖥 MCP: ${mcpToolNames.slice(0,8).join(', ')}${mcpToolNames.length > 8 ? ` +${mcpToolNames.length - 8} more` : ''}` : '',
      delegateToolNames.length > 0 ? `⚙ Advanced (use ONLY after direct tools fail): ${delegateToolNames.join(', ')}` : '',
      `── START WITH direct tools (Data/Web/Files). Delegate ONLY if the task is too large for one agent. ──`,
    ].filter(Boolean).join('\n')

    // 9. Build the LLM-visible context block — what CONNECTIONS this agent has
    //    The LLM sees this BEFORE it starts calling tools, so it knows ALL
    //    databases, connectors, MCPs, and knowledge bases available to it.
    let dbContextLine
    if (allDbConnections.length === 0) {
      dbContextLine = hasDbTools
        ? `Databases: ✅ DB tools available — use listTables to discover schemas`
        : `Databases: ❌ NONE — you CANNOT run SQL queries`
    } else if (allDbConnections.length === 1) {
      const db = allDbConnections[0]
      dbContextLine = `Databases: ✅ ${db.name} — ${activeDbStatus}`
    } else {
      const dbList = allDbConnections.map(d =>
        d.name === activeDbName ? `${d.name} ⬅ active` : d.name
      ).join(', ')
      dbContextLine = `Databases: ✅ ${allDbConnections.length} databases — ${activeDbName} is active (${activeDbStatus})\n  All: ${dbList}`
    }

    const llmContextBlock = [
      toolsSection,
      ``,
      `── YOUR CONNECTIONS ──`,
      `Model: ${isTrainedModel ? 'TRAINED (fine-tuned for this database)' : 'STANDARD — be careful with SQL, always check schema first'}`,
      dbContextLine,
      hasDbTools ? `  → Use describeTable to see columns FIRST, then runQuery with correct SQL` : '',
      hasHttp ? `HTTP: ✅ you can call external APIs` : '',
      hasBrowser ? `Browser: ✅ you can control a real web browser` : '',
      hasPublish ? `Publish: ✅ you can publish reports to the dashboard` : '',
      connectorBlock,
      mcpBlock,
      knowledgeBlock,
      `── END CONNECTIONS ──`,
    ].filter(Boolean).join('\n')

    // ── Inject as the FIRST user message so LLM knows its connections
    // BEFORE the "Begin working" prompt and before any tool calls start.
    // Injecting last (old behaviour) caused small models to hallucinate
    // tools/data they didn't have because they started acting at step 3
    // before reading their capabilities at step 4.
    execMessages.unshift({
      role: 'user',
      content: llmContextBlock
    })
    console.log(`[Agent Context] Injected connection context at position 0 of execMessages (${llmContextBlock.length} chars)`)
    console.log(`[Agent Context] Context preview: ${llmContextBlock.slice(0, 300)}...`)

    // 10. If the active DB connection is broken, inject a warning
    if (hasDb && activeDbStatus.startsWith('UNREACHABLE')) {
      execMessages.push({
        role: 'user',
        content: `⚠️  DATABASE CONNECTION ERROR: The active database "${activeDbName}" is NOT reachable. runQuery, describeTable, and listTables WILL FAIL against it. ${allDbConnections.length > 1 ? 'Other databases may still be reachable — try them if needed.' : 'Do NOT call any DB tools.'}`
      })
      console.warn(`[Agent Context] Injected DB-down warning into execMessages`)
    }

    let actionCount = 0
    const maxActions = agent.max_actions_per_run || 20
    let taskSatisfied = false
    let reflectionLoops = 0
    const MAX_REFLECTION_LOOPS = 3
    // Track last tool+input fingerprint to detect infinite loops in small models
    const _executedToolPrints = new Set()  // fingerprint → true, blocks re-execution
    const _executedToolResults = new Map()  // fingerprint → stored result (for duplicate return)
    let _consecutiveDedupCount = 0        // count consecutive duplicate calls to break loops
    let _consecutivePublishRejections = 0  // count consecutive publish rejections (fabricated data)
    // Track JSON tool-call retries for models without native function calling
    let toolRetryCount = 0
    const MAX_TOOL_RETRIES = 1
    // Maximum time to wait for a delegation (a2a_call / delegate_task) to complete.
    // Matches workflow.service.js's AGENT_TASK_TIMEOUT_MS so crew steps and inline
    // delegation share the same SLA. After this the caller sees a timeout error.
    const DELEGATION_TIMEOUT_MS = 10 * 60 * 1000

    // Expose current task ID and context to the agent object for tools like a2a_call, delegate_task, and HITL resume
    agent._currentTaskId = task.id
    agent._taskContext = task.context || {}
    agent._taskGoal = task.goal  // for tool handlers that need the goal (e.g. report title)
    agent._reportPublishedThisTask = false  // reset per-task dedup flag
    agent._hasRealData = false  // set by data-gathering tools (NOT schema-introspection)
    agent._describedTables = new Set()  // track which tables have been described for smart SQL error guidance
    agent._calledPlaybooks = new Set()  // prevent duplicate NL playbook invocations within same task
    agent._agentCreatedThisTask = false  // prevent duplicate create_agent calls within same task
    agent._hasRunAnyTool = false  // gate: allow delegation (create_agent) only after agent tries at least one tool
    agent._hasTriedDirectWork = false  // gate: agent attempted domain-specific work (runQuery, http_request, local_shell, etc.)
    // ── Tool category classification — single source of truth for synthesis
    // gating and data-gathering tracking. Every tool result gets classified
    // once after execution; synthesis uses categories, not hardcoded names.
    const TOOL_CATEGORY = {
      DATA: 'DATA',           // produces business data (runQuery, http_request, connector tools, etc.)
      SCHEMA: 'SCHEMA',       // produces metadata (listTables, describeTable)
      PROVISIONING: 'PROVISIONING',  // creates resources (create_agent, create_connector, etc.)
      PUBLISH: 'PUBLISH',     // publishes results (publish_dashboard_report)
      ARTIFACT: 'ARTIFACT',   // writes files (write_artifact)
      DELEGATION: 'DELEGATION',  // delegates to other agents (delegate_task, a2a_call)
      SHELL: 'SHELL',         // executes shell commands (local_shell__execute)
    }

    function classifyToolResult(toolName, result) {
      // ── Category ──────────────────────────────────────────────────────
      if (['listDatabases','useDatabase','listTables','describeTable'].includes(toolName)) {
        result.category = TOOL_CATEGORY.SCHEMA
      } else if (toolName === 'publish_dashboard_report') {
        result.category = TOOL_CATEGORY.PUBLISH
      } else if (['create_agent','create_connector','create_workflow','create_trigger'].includes(toolName)) {
        result.category = TOOL_CATEGORY.PROVISIONING
      } else if (['delegate_task','a2a_call'].includes(toolName)) {
        result.category = TOOL_CATEGORY.DELEGATION
      } else if (toolName === 'write_artifact') {
        result.category = TOOL_CATEGORY.ARTIFACT
      } else if (toolName === 'local_shell__execute') {
        result.category = TOOL_CATEGORY.SHELL
      } else {
        result.category = TOOL_CATEGORY.DATA
      }

      // ── hasStructuredData — did the tool return actual queryable data? ──
      result.hasStructuredData = !!(
        (Array.isArray(result.rows) && result.rows.length > 0) ||
        (Array.isArray(result.data) && result.data.length > 0) ||
        (typeof result.data === 'object' && result.data !== null
          && !(toolName === 'http_request' && typeof result.data === 'string')) ||
        (Array.isArray(result.matches) && result.matches.length > 0) ||
        (Array.isArray(result.files) && result.files.length > 0) ||
        (typeof result.content === 'string' && result.content.length > 0) ||
        (result.databases?.length > 0) ||
        result.created === true
      )
    }

    // Fire-and-forget audit helper — logs tool executions without blocking the loop
    const _auditToolExecution = (toolName, input, toolResult, deduped) => {
      try {
        auditLog({
          eventType: 'agent.tool_executed', tenantId,
          actorId: agent.id, actorType: 'AGENT',
          resourceType: 'AgentTool', resourceId: task.id,
          action: toolName,
          metadata: {
            taskId: task.id,
            input: JSON.stringify(input).slice(0, 500),
            success: !!toolResult?.success,
            error: toolResult?.error ? String(toolResult.error).slice(0, 300) : undefined,
            deduped: !!deduped,
            actionIdx: actionCount
          }
        }).catch(() => {}) // swallow — never block the execution loop
      } catch { /* audit failure must not break execution */ }
    }

    // ════════════════════════════════════════════════════════════════════════
    // TRAINED MODEL FAST PATH — only when the agent has a *trained/custom*
    // model (detected via _isTrainedModel flag from DB resolution). Standard
    // models with connector-scope DB access go through the normal reflection
    // loop below with tool_choice:'auto' — they're NOT forced to call tools.
    //
    // Trained models use chat-style simple tool loop: all scoped tools,
    // tool_choice:'required' loop, aggressive regex JSON parser, no reflection.
    // Uses ALL tools the agent is scoped for — not just DB tools — so custom
    // models trained for HTTP, browser, file ops etc. work here too.
    // ════════════════════════════════════════════════════════════════════════
    if (agent._isTrainedModel && agentDbConnectionString) {
      console.log(`[Task ${task.id}] Trained model fast path — chat-style loop (model: ${agent.llm_model})`)
      broadcastTelemetry(tenantId, 'agent.phase', { taskId: task.id, phase: 'thinking', label: 'Querying database...' })

      // ── Use ALL scoped tools — not just DB tools ──────────────────────
      // Custom models can be trained for HTTP requests, browser automation,
      // file operations, etc. — not just SQL. Strip only listTables when
      // schema is preloaded (it's redundant). Keep everything else.
      const dbToolsPresent = toolDefinitions.some(t =>
        t.name === 'runQuery' || t.name === 'describeTable' || t.name === 'listTables'
      )
      const fastTools = agent._schemaPreloaded
        ? toolDefinitions.filter(t => t.name !== 'listTables')
        : toolDefinitions

      // ── Chat-style JSON parser: regex covers ALL tool names ───────────
      const _chatStyleParseToolCall = (text) => {
        if (!text || typeof text !== 'string') return null
        let cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim()
        // Try full parse first
        try {
          const p = JSON.parse(cleaned)
          if (p.name && typeof p.name === 'string') {
            const args = p.arguments || p.args || p.parameters || p.input || {}
            const argsStr = typeof args === 'string' ? args : JSON.stringify(args)
            return { id: `chat_${Date.now()}`, type: 'function', function: { name: p.name, arguments: argsStr } }
          }
        } catch {}
        // Regex extraction: find JSON objects with any known tool name
        const toolNames = fastTools.map(t => t.name).join('|')
        // Escape dots for regex (MCP tools have dots: mcp__server__tool.name)
        const escapedNames = toolNames.replace(/\./g, '\\.')
        const rx = new RegExp(`\\{[^{}]*"name"\\s*:\\s*"(${escapedNames})"[^{}]*\\}`)
        const m = cleaned.match(rx)
        if (m) {
          try {
            const p = JSON.parse(m[0])
            const args = p.arguments || p.args || p.parameters || p.input || {}
            const argsStr = typeof args === 'string' ? args : JSON.stringify(args)
            return { id: `chat_${Date.now()}`, type: 'function', function: { name: p.name, arguments: argsStr } }
          } catch {}
        }
        return null
      }

      // ── Fast loop: max 5 iterations, mirroring chat's MAX_CHAT_TOOL_ITERATIONS ──
      let hasQueriedData = false
      let fastPublishDone = false
      const FAST_MAX = 5

      for (let fi = 0; fi < FAST_MAX && !taskSatisfied; fi++) {
        // tool_choice: 'required' until data exists, then 'required' for publish, then 'auto'
        const tcMode = (!hasQueriedData) ? 'required'
          : (hasQueriedData && !fastPublishDone && publishToolDef) ? 'required'
          : 'auto'

        // Dynamic tool list: include publish only after data is available
        const activeFastTools = (hasQueriedData && publishToolDef)
          ? [...fastTools, publishToolDef]
          : fastTools

        if (taskTimedOut) throw new AppError('TASK_TIMEOUT', 'Task exceeded maximum execution time', 408)

        const resp = await completeStream({
          tenantId: agent.tenant_id,
          agentId: agent.id,
          messages: execMessages,
          tools: activeFastTools,
          model: agent.llm_model,
          llmConfig: agent.llm_config,
          provider: agent.llm_provider,
          temperature: 0.2,  // match chat's temperature
          tool_choice: tcMode,
          onToken: (token) => {
            broadcastTelemetry(tenantId, 'agent.token', { taskId: task.id, phase: 'thinking', token })
          }
        })

        totalTokens.prompt += resp.usage.prompt
        totalTokens.completion += resp.usage.completion
        totalTokens.total += resp.usage.total

        // ── No structured tool calls → try chat-style JSON parser ────────
        if (!resp.toolCalls?.length && resp.content) {
          const syntheticCall = _chatStyleParseToolCall(resp.content)
          if (syntheticCall) {
            execMessages.push({ role: 'assistant', content: resp.content, tool_calls: [syntheticCall] })
            const input = safeParseJSON(syntheticCall.function.arguments) || {}
            // ── Dedup guard (same as main loop) — prevent infinite retries ──
            const fp = `${syntheticCall.function.name}::${JSON.stringify(input)}`
            if (_executedToolPrints.has(fp)) {
              const cachedResult = _executedToolResults.get(fp)
              _consecutiveDedupCount++
              if (_consecutiveDedupCount >= 3) {
                console.warn(`[FastPath-Dedup] Breaking loop after ${_consecutiveDedupCount} consecutive duplicate calls to ${syntheticCall.function.name}`)
                execMessages.push({
                  role: 'user',
                  content: `⛔ STOP calling ${syntheticCall.function.name} with the same arguments — it keeps failing. Try a DIFFERENT approach. If no alternative exists, honestly report the failure.`
                })
                _consecutiveDedupCount = 0
                break  // exit the fast loop entirely
              }
              const toolResult = cachedResult || { success: false, error: `Duplicate call blocked — ${syntheticCall.function.name} already failed. Do NOT retry.` }
              // Handle the dedup'd result just like a fresh result below
              actionCount++
              actions.push({
                id: syntheticCall.id, skill: syntheticCall.function.name, input,
                output: toolResult, timestamp: new Date().toISOString()
              })
              execMessages.push({
                role: 'tool', tool_call_id: syntheticCall.id,
                content: JSON.stringify(toolResult)
              })
              broadcastTelemetry(tenantId, 'agent.tool_result', {
                taskId: task.id, actionIdx: actionCount,
                tool: syntheticCall.function.name, success: toolResult.success, output: toolResult
              })
              await query(`UPDATE agent_tasks SET actions = $1 WHERE id = $2 AND tenant_id = $3`, [JSON.stringify(actions), task.id, tenantId])
              continue  // skip to next loop iteration
            }
            _executedToolPrints.add(fp)

            const toolResult = await executeTool(syntheticCall.function.name, input, agent, skills)
            _executedToolResults.set(fp, toolResult)
            _consecutiveDedupCount = 0  // fresh (non-dedup) call resets counter
            actionCount++
            agent._hasRunAnyTool = true  // gate for create_agent delegation

            if (syntheticCall.function.name === 'runQuery' && toolResult.success) {
              hasQueriedData = true
              agent._ranQuerySuccessfully = true
              agent._lastQueryRows = toolResult.rows
              agent._lastQueryColumns = toolResult.columns
            }
            classifyToolResult(syntheticCall.function.name, toolResult)
            // Real data = DATA-category tools that returned structured output
            if (toolResult.success && toolResult.category === TOOL_CATEGORY.DATA && toolResult.hasStructuredData) {
              hasQueriedData = true
              agent._hasRealData = true
            }
            if (syntheticCall.function.name === 'publish_dashboard_report' && toolResult.success) {
              fastPublishDone = true
              agent._reportPublishedThisTask = true
              taskSatisfied = true
            }
            // Inject newly created connector tools mid-task (create_connector)
            if (toolResult.newTools?.length) {
              for (const nt of toolResult.newTools) toolDefinitions.push(nt)
            }

            actions.push({
              id: syntheticCall.id, skill: syntheticCall.function.name, input,
              output: toolResult, timestamp: new Date().toISOString()
            })
            _auditToolExecution(syntheticCall.function.name, input, toolResult, false)
            execMessages.push({
              role: 'tool', tool_call_id: syntheticCall.id,
              content: JSON.stringify(toolResult)
            })
            broadcastTelemetry(tenantId, 'agent.tool_result', {
              taskId: task.id, actionIdx: actionCount,
              tool: syntheticCall.function.name, success: toolResult.success, output: toolResult
            })

            // Inject publish prompt after successful runQuery
            if (syntheticCall.function.name === 'runQuery' && toolResult.success && publishToolDef) {
              execMessages.push({
                role: 'user',
                content: `✅ Real data retrieved! NOW call publish_dashboard_report with { title: "${task.goal.slice(0, 80)}", df: <paste the rows from runQuery result>, summary: "<one-sentence>", output_format: "chart" }. Do NOT write any text first — output the tool call JSON IMMEDIATELY.`
              })
            }

            // ── Column-error retry: mirror chat.service.js ──
            if (syntheticCall.function.name === 'runQuery' && !toolResult.success && !hasQueriedData) {
              const errMsg = typeof toolResult.error === 'string' ? toolResult.error : JSON.stringify(toolResult.error || '')
              if (/column|does not exist|relation.*does not exist|syntax error/i.test(errMsg)) {
                execMessages.push({
                  role: 'user',
                  content: `⚠️  Your SQL failed: "${errMsg}". You MUST call describeTable on the relevant table(s) to see the ACTUAL column names, then rewrite your query using ONLY those columns. Output a tool call JSON now — do NOT fabricate an answer.`
                })
              }
            }
            await query(`UPDATE agent_tasks SET actions = $1 WHERE id = $2 AND tenant_id = $3`, [JSON.stringify(actions), task.id, tenantId])
            continue
          }
          // ── Can't parse → inject retry prompt ──────────────────────────
          if (!hasQueriedData) {
            execMessages.push({ role: 'assistant', content: resp.content })
            const toolHints = fastTools.slice(0, 4).map(t =>
              `{"name":"${t.name}","arguments":{…}}`
            ).join(' or ')
            execMessages.push({
              role: 'user',
              content: `You MUST call a tool right now. Output ONLY a JSON tool call — one of: ${toolHints}. Do NOT output any other text.`
            })
            continue
          }
          // Already have data, model is done
          taskSatisfied = true
          break
        }

        // ── Structured tool calls ────────────────────────────────────────
        if (!resp.toolCalls?.length) {
          // No tool calls and no content → give up
          if (hasQueriedData) taskSatisfied = true
          break
        }

        execMessages.push({ role: 'assistant', content: resp.content, tool_calls: resp.toolCalls })
        actionCount += resp.toolCalls.length

        for (const tc of resp.toolCalls) {
          const input = safeParseJSON(tc.function.arguments || '{}') || {}
          // ── Dedup guard (same as main loop + chat-style path) ──
          const fp = `${tc.function.name}::${JSON.stringify(input)}`
          let toolResult
          if (_executedToolPrints.has(fp)) {
            const cachedResult = _executedToolResults.get(fp)
            _consecutiveDedupCount++
            if (_consecutiveDedupCount >= 3) {
              console.warn(`[FastPath-Dedup] Breaking loop after ${_consecutiveDedupCount} consecutive duplicate calls to ${tc.function.name}`)
              execMessages.push({
                role: 'user',
                content: `⛔ STOP calling ${tc.function.name} with the same arguments — it keeps failing. Try a DIFFERENT approach. If no alternative exists, honestly report the failure.`
              })
              _consecutiveDedupCount = 0
              break  // exit the tool-call loop
            }
            toolResult = cachedResult || { success: false, error: `Duplicate call blocked — ${tc.function.name} already failed. Do NOT retry.` }
          } else {
            _executedToolPrints.add(fp)
            toolResult = await executeTool(tc.function.name, input, agent, skills)
            _executedToolResults.set(fp, toolResult)
            _consecutiveDedupCount = 0
            agent._hasRunAnyTool = true  // gate for create_agent delegation
          }

          if (tc.function.name === 'runQuery' && toolResult.success) {
            hasQueriedData = true
            agent._ranQuerySuccessfully = true
            agent._lastQueryRows = toolResult.rows
            agent._lastQueryColumns = toolResult.columns
          }
          classifyToolResult(tc.function.name, toolResult)
          // Real data = DATA-category tools that returned structured output
          if (toolResult.success && toolResult.category === TOOL_CATEGORY.DATA && toolResult.hasStructuredData) {
            hasQueriedData = true
            agent._hasRealData = true
          }
          if (tc.function.name === 'publish_dashboard_report' && toolResult.success) {
            fastPublishDone = true
            agent._reportPublishedThisTask = true
            taskSatisfied = true
          }
          // Inject newly created connector tools mid-task (create_connector)
          if (toolResult.newTools?.length) {
            for (const nt of toolResult.newTools) toolDefinitions.push(nt)
          }

          actions.push({
            id: tc.id, skill: tc.function.name, input,
            output: toolResult, timestamp: new Date().toISOString()
          })
          _auditToolExecution(tc.function.name, input, toolResult, false)
          execMessages.push({
            role: 'tool', tool_call_id: tc.id,
            content: JSON.stringify(toolResult)
          })
          broadcastTelemetry(tenantId, 'agent.tool_result', {
            taskId: task.id, actionIdx: actionCount,
            tool: tc.function.name, success: toolResult.success, output: toolResult
          })

          // Inject publish prompt after successful runQuery
          if (tc.function.name === 'runQuery' && toolResult.success && publishToolDef && !fastPublishDone) {
            execMessages.push({
              role: 'user',
              content: `✅ Real data retrieved! NOW call publish_dashboard_report with { title: "${task.goal.slice(0, 80)}", df: <paste the rows from runQuery result>, summary: "<one-sentence>", output_format: "chart" }. Do NOT write any text first — output the tool call JSON IMMEDIATELY.`
            })
          }

          // ── Column-error retry: mirror chat.service.js ──
          if (tc.function.name === 'runQuery' && !toolResult.success && !hasQueriedData) {
            const errMsg = typeof toolResult.error === 'string' ? toolResult.error : JSON.stringify(toolResult.error || '')
            if (/column|does not exist|relation.*does not exist|syntax error/i.test(errMsg)) {
              execMessages.push({
                role: 'user',
                content: `⚠️  Your SQL failed: "${errMsg}". You MUST call describeTable on the relevant table(s) to see the ACTUAL column names, then rewrite your query using ONLY those columns. Output a tool call JSON now — do NOT fabricate an answer.`
              })
            }
          }

          // ── publish_dashboard_report rejected (fabricated data) in fast path ──
          if (tc.function.name === 'publish_dashboard_report' && !toolResult.success && toolResult.error?.includes('NOT called runQuery')) {
            console.warn('[FAST-PATH FABRICATED] publish rejected — forcing runQuery')
            execMessages.push({
              role: 'user',
              content: '⛔ Your report was REJECTED — you fabricated the df data. You have NOT called runQuery yet. Call runQuery with a proper SQL query NOW using real column names from describeTable. Do NOT retry publish_dashboard_report until runQuery succeeds.'
            })
            hasQueriedData = false  // force back to data-gathering phase
          }
        }

        await query(`UPDATE agent_tasks SET actions = $1 WHERE id = $2 AND tenant_id = $3`, [JSON.stringify(actions), task.id, tenantId])
      }

      // ── Fast path finished: skip reflection entirely ───────────────────
      if (hasQueriedData) {
        taskSatisfied = true
        console.log(`[Task ${task.id}] Trained model fast path SUCCESS — hasQueriedData=${hasQueriedData}, fastPublishDone=${fastPublishDone}, actions=${actionCount}`)
      } else {
        // ── Fast path failed (no data after 5 iterations) → fall through
        // to the normal reflection/synthesis cycle below. Seed the dedup
        // tracker so we don't re-execute the same failed calls. ────────────
        for (const a of actions) {
          const fp = `${a.skill}::${JSON.stringify(a.input)}`
          _executedToolPrints.add(fp)
        }
        console.log(`[Task ${task.id}] Trained model fast path FAILED — falling through to normal cycle (${actions.length} actions attempted, ${_executedToolPrints.size} fingerprints recorded)`)
        broadcastTelemetry(tenantId, 'agent.phase', { taskId: task.id, phase: 'thinking', label: 'Fast path failed, trying full tool set...' })
      }
    }

    while (!taskSatisfied && reflectionLoops < MAX_REFLECTION_LOOPS && actionCount < maxActions) {
      reflectionLoops++
      let continueToolLoop = true
      const actionsBeforeLoop = actions.length  // track for failure detection in reflection

      // Tool execution sub-loop
      while (continueToolLoop && actionCount < maxActions) {
        // Check if task was cancelled by user
        const { rows: [currStatus] } = await query('SELECT status FROM agent_tasks WHERE id = $1', [task.id])
        if (currStatus?.status === 'CANCELLED') {
          broadcastTelemetry(tenantId, 'agent.phase', { taskId: task.id, phase: 'cancelled', label: 'Execution stopped by user' })
          return { success: false, status: 'CANCELLED', error: 'Task stopped by user' }
        }

        if (taskTimedOut) throw new AppError('TASK_TIMEOUT', `Task exceeded maximum execution time`, 408)

        broadcastTelemetry(tenantId, 'agent.phase', { taskId: task.id, phase: 'thinking', label: 'Thinking...' })

        // Force tool use on first iteration for TRAINED models only.
        // Standard models use 'auto' — forcing them to call tools they
        // aren't fine-tuned for leads to hallucination and broken SQL.
        //
        // Mirror chat's hasQueriedData pattern:
        // - keep 'required' until runQuery succeeds (has real data) — TRAINED ONLY
        // - keep 'required' for the publish step (has data but no report yet) — TRAINED ONLY
        // - switch to 'auto' only AFTER both data-gathering AND publish are done
        // - STANDARD models: always 'auto' (they decide whether to query)
        const needsDataPhase = agent._isTrainedModel && agentDbConnectionString && !agent._hasRealData
        const needsPublishPhase = agent._isTrainedModel && agent._hasRealData && !agent._reportPublishedThisTask
        const thinkingTc = (needsDataPhase || needsPublishPhase)
          ? 'required'
          : (agent._isTrainedModel && actionCount === 0 ? 'required' : 'auto')
        if (!agent._isTrainedModel && agentDbConnectionString) {
          console.log(`[Task ${task.id}] Standard model with DB access — using tool_choice:auto (not forcing tool calls)`)
        }

        // ── Dynamic tool list: only include publish_dashboard_report AFTER
        // runQuery has succeeded (or if no DB is configured). This prevents
        // small models from calling publish with fabricated data first. ──
        const activeTools = (agent._hasRealData || !agentDbConnectionString) && publishToolDef
          ? [...toolDefinitions, publishToolDef]
          : toolDefinitions

        const response = await completeStream({
          tenantId: agent.tenant_id,
          agentId: agent.id,
          messages: execMessages,
          tools: activeTools,
          model: agent.llm_model,
          llmConfig: agent.llm_config,
          provider: agent.llm_provider,
          tool_choice: thinkingTc,
          onToken: (token) => {
            broadcastTelemetry(tenantId, 'agent.token', { taskId: task.id, phase: 'thinking', token })
          }
        })

        totalTokens.prompt += response.usage.prompt
        totalTokens.completion += response.usage.completion
        totalTokens.total += response.usage.total

        if (response.finishReason === 'stop' || !response.toolCalls?.length) {
          // ── Model didn't emit structured tool_calls ──────────────────
          // Try to parse the raw text as a JSON tool call (common with
          // Ollama/small models that don't support native function calling
          // but DO follow the prompt instruction to output JSON).
          // Use activeTools (not toolDefinitions) so publish_dashboard_report
          // is included when the agent has real data to report.
          let syntheticTc = null
          try { syntheticTc = tryParseToolCallFromText(response.content, activeTools) } catch { /* safeParseJSON is hardened but just in case */ }
          if (syntheticTc) {
            // Pretend it was a real tool call so the loop continues normally
            execMessages.push({ role: 'assistant', content: response.content, tool_calls: [syntheticTc] })
            response.toolCalls = [syntheticTc]
            // Fall through to the tool execution block below
          } else if (toolRetryCount < MAX_TOOL_RETRIES && activeTools.length > 0 && response.content) {
            toolRetryCount++
            // Still no tool call — inject a prompt guiding the model to output JSON
            execMessages.push({ role: 'assistant', content: response.content })
            const toolNames = activeTools.map(t => `"${t.name}"`).join(', ')
            const toolDesc = activeTools.map(t => `- ${t.name}: ${t.description}`).join('\n')
            execMessages.push({
              role: 'user',
              content: `You MUST call a tool right now. Do NOT describe what you will do — output exactly:\n{"name": "<tool_name>", "arguments": {<params>}}\n\nAvailable tools:\n${toolDesc}\n\nWhere <tool_name> is one of: ${toolNames}`
            })
            continueToolLoop = true
            continue
          } else {
            execMessages.push({ role: 'assistant', content: response.content })
            continueToolLoop = false
          }
        }

        if (response.toolCalls?.length > 0) {
        execMessages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls })

        // ── Parallel execution for independent tool calls ────────────────
        // When the LLM emits multiple tool calls (e.g. describeTable on
        // two tables), execute them concurrently. Only the first duplicate
        // check runs sequentially; independent calls run in parallel.
        actionCount += response.toolCalls.length

        // Build all tool call payloads up front
        const tcPayloads = response.toolCalls.map(tc => ({
          tc,
          input: safeParseJSON(tc.function.arguments || '{}') || {},
        }))

        // ── Pre-scan dedup (synchronous): catch both cross-batch duplicates
        // (from prior iterations) AND same-batch duplicates BEFORE Promise.all.
        // Without this, concurrent .has()/.add() calls in Promise.all cause
        // race conditions where all iterations see an empty Set and none dedup.
        const seenThisBatch = new Set()
        for (const p of tcPayloads) {
          p._fp = `${p.tc.function.name}::${JSON.stringify(p.input)}`
          p._dup = _executedToolPrints.has(p._fp) || seenThisBatch.has(p._fp)
          if (!p._dup) {
            _executedToolPrints.add(p._fp)
            seenThisBatch.add(p._fp)
          }
        }

        // Execute all tools in parallel
        const results = await Promise.all(tcPayloads.map(async (p) => {
          const { tc, input, _dup, _fp } = p
          // ── Dedup guard: return cached result or block same-batch duplicate ──
          if (_dup) {
            const cachedResult = _executedToolResults.get(_fp)
            if (cachedResult) {
              console.warn(`[Dedup] Returning cached result for ${tc.function.name}`)
              // Propagate describeTable cached state
              if (tc.function.name === 'describeTable' && cachedResult?.columns?.length) {
                agent._lastDescribeColumns = cachedResult.columns.map(c => c.column_name)
                agent._describedTables.add(input?.table || 'unknown')
              }
              return { tc, input, toolResult: cachedResult, halt: false, deduped: true }
            }
            // Same-batch duplicate (no cached result yet — original is running in parallel)
            console.warn(`[Dedup] Blocking same-batch duplicate: ${tc.function.name}`)
            return { tc, input, toolResult: { success: false, error: `⛔ Duplicate call blocked — ${tc.function.name} was already called in this batch with identical arguments. Use the result from the first call.` }, halt: false, deduped: true }
          }
          const toolResult = await executeTool(tc.function.name, input, agent, skills)
          // Cache ALL results (success + failure) for duplicate-return.
          // If we only cache successes, failed calls fall back to a fake
          // { success: true, _fromDedupCache: true } which breaks the model.
          _executedToolResults.set(_fp, toolResult)
          // Classify the result so synthesis can use categories, not hardcoded names
          classifyToolResult(tc.function.name, toolResult)
          // Track that agent has run at least one tool (gates create_agent delegation)
          agent._hasRunAnyTool = true
          // Mark real data gathered from DATA-category tools that returned structured output.
          // SCHEMA/PROVISIONING/PUBLISH/DELEGATION tools don't count as "real data".
          if (toolResult.success && toolResult.category === TOOL_CATEGORY.DATA && toolResult.hasStructuredData) {
            agent._hasRealData = true
          }
          // Mark direct work attempt for delegation gate
          if (toolResult.category === TOOL_CATEGORY.DATA || toolResult.category === TOOL_CATEGORY.SHELL) {
            agent._hasTriedDirectWork = true
          }
          // Inject newly created connector tools mid-task (create_connector)
          if (toolResult.newTools?.length) {
            for (const nt of toolResult.newTools) toolDefinitions.push(nt)
          }
          // Capture describeTable columns for SQL error hints
          if (tc.function.name === 'describeTable' && toolResult.success && toolResult.columns?.length) {
            agent._lastDescribeColumns = toolResult.columns.map(c => c.column_name)
            agent._describedTables.add(input?.table || 'unknown')
          }
          return { tc, input, toolResult, halt: !!toolResult.awaiting_approval, deduped: false }
        }))

        // Process results — if any needed approval, stop the loop
        let haltLoop = false
        for (const { tc, input, toolResult, halt, deduped } of results) {
          if (halt) {
            actions.push({
              id: tc.id, skill: tc.function.name, input,
              output: toolResult, timestamp: new Date().toISOString()
            })
            broadcastTelemetry(tenantId, 'agent.tool_result', {
              taskId: task.id, actionIdx: actionCount,
              tool: tc.function.name, success: false,
              output: { awaiting_approval: true, approvalId: toolResult.approvalId }
            })
            taskSatisfied = true
            continueToolLoop = false
            haltLoop = true
            break
          }

          broadcastTelemetry(tenantId, 'agent.tool_result', {
            taskId: task.id, actionIdx: actionCount,
            tool: tc.function.name, success: toolResult.success, output: toolResult
          })

          actions.push({
            id: tc.id, skill: tc.function.name, input,
            output: toolResult, timestamp: new Date().toISOString()
          })
          _auditToolExecution(tc.function.name, input, toolResult, deduped)

          execMessages.push({
            role: 'tool', tool_call_id: tc.id,
            content: JSON.stringify(toolResult)
          })

          // ── Dedup loop breaker: if model keeps calling the same tool+input,
          // inject the actual data it needs and force it to move on ──
          if (deduped) {
            _consecutiveDedupCount++
            // EPERM-specific: if the tool keeps failing with permission errors,
            // the model MUST stop — no amount of retrying fixes macOS permissions.
            const isEperm = toolResult?.error && /EPERM|EACCES|Permission denied|Full Disk Access/i.test(String(toolResult.error))
            if (isEperm && _consecutiveDedupCount >= 2) {
              console.warn(`[Dedup] Breaking EPERM loop after ${_consecutiveDedupCount} consecutive calls to ${tc.function.name}`)
              execMessages.push({
                role: 'user',
                content: `⛔⛔⛔ PERMISSION DENIED — STOP calling ${tc.function.name}! The directory cannot be accessed due to macOS security. Retrying will NOT fix this. You MUST:\n1. Accept that ${tc.function.name} cannot access this directory\n2. Use a DIFFERENT approach to complete the task — do you have database access (listTables, describeTable, runQuery)? Use those instead.\n3. If no other data source exists, honestly report: "Unable to access the data — macOS permissions blocked directory access. Grant Full Disk Access in System Settings → Privacy & Security → Full Disk Access to the terminal running the API."\n\nDo NOT call ${tc.function.name} again.`
              })
              continueToolLoop = false  // force reflection on next iteration
              _consecutiveDedupCount = 0
            } else if (_consecutiveDedupCount >= 3) {
              console.warn(`[Dedup] Breaking loop after ${_consecutiveDedupCount} consecutive duplicate calls to ${tc.function.name}`)
              execMessages.push({
                role: 'user',
                content: `⛔ STOP calling ${tc.function.name} — you already have its results above. Your next action MUST be runQuery with correct SQL using real column names from the describeTable output you already received. Do NOT describe any table again. The columns are visible in the tool results above — use them to write a correct SQL query NOW.`
              })
              continueToolLoop = false
              _consecutiveDedupCount = 0  // reset for next phase
            }
          } else {
            _consecutiveDedupCount = 0  // non-dedup call resets the counter
          }

          // ── publish_dashboard_report success: mark done and stop tool loop ──
          if (tc.function.name === 'publish_dashboard_report' && toolResult.success) {
            console.log(`[Task ${task.id}] Report published — marking task satisfied`)
            agent._reportPublishedThisTask = true
            taskSatisfied = true
            continueToolLoop = false
            break
          }

          // ── create_agent success: when task goal is about agent creation,
          // mark done. Otherwise let the agent use delegate_task next. ──
          if (tc.function.name === 'create_agent' && toolResult.success) {
            const isAgentCreationGoal = /create.*agent|build.*agent|provision.*agent|set.*up.*agent|make.*agent|new agent/i.test(task.goal)
            if (isAgentCreationGoal) {
              console.log(`[Task ${task.id}] Agent created — goal was agent creation, marking satisfied`)
              taskSatisfied = true
              continueToolLoop = false
              break
            }
          }

          // ── runQuery success: aggressively inject publish instruction ──
          if (tc.function.name === 'runQuery' && toolResult.success && !agent._reportPublishedThisTask && publishToolDef) {
            execMessages.push({
              role: 'user',
              content: `✅ Real data retrieved! NOW call publish_dashboard_report with { title: "${task.goal.slice(0, 80)}", df: <paste the rows from runQuery result>, summary: "<one-sentence>", output_format: "chart" }. Do NOT write any text first — output the tool call JSON IMMEDIATELY.`
            })
          }

          // ── publish_dashboard_report rejected (fabricated data): force runQuery ──
          if (tc.function.name === 'publish_dashboard_report' && !toolResult.success && toolResult.error?.includes('NOT called runQuery')) {
            _consecutivePublishRejections++
            console.warn(`[FABRICATED-DATA] publish_dashboard_report rejected #${_consecutivePublishRejections} — model fabricated data without calling runQuery`)
            if (_consecutivePublishRejections >= 2) {
              console.warn('[FABRICATED-DATA] Breaking tool loop after 2 consecutive publish rejections — forcing reflection')
              execMessages.push({
                role: 'user',
                content: '⛔⛔⛔ STOP! You have been rejected TWICE for fabricating data. You have NOT called runQuery. Your publish_dashboard_report calls were blocked because the data was made up. The ONLY way forward is: (1) call runQuery with a correct SQL query using real column names from describeTable, (2) get actual rows back, (3) THEN call publish_dashboard_report with those real rows. If you cannot write a correct SQL query, call describeTable first to verify the column names, then write the query. Do NOT call publish_dashboard_report again until runQuery succeeds.'
              })
              continueToolLoop = false
              _consecutivePublishRejections = 0
            } else {
              execMessages.push({
                role: 'user',
                content: '⛔ Your report was REJECTED — you fabricated the df data. You have NOT called runQuery yet. You MUST call runQuery with a proper SQL query (JOIN + GROUP BY + ORDER BY + LIMIT) using the REAL column names from describeTable. Do NOT retry publish_dashboard_report — call runQuery NOW.'
              })
            }
          } else {
            _consecutivePublishRejections = 0  // reset on non-publish or successful publish
          }
        }

        // Batch DB update for all actions
        await query(`UPDATE agent_tasks SET actions = $1 WHERE id = $2 AND tenant_id = $3`, [JSON.stringify(actions), task.id, tenantId])

        if (haltLoop) break
      }
      } // Ends inner while(continueToolLoop)

      // If we ran out of actions, break entirely
      if (actionCount >= maxActions) break

      // ── Smart skip: If report already published, done ───
      // Works for both DB and non-DB agents (report itself is the output)
      if (agent._reportPublishedThisTask) {
        taskSatisfied = true
        break
      }

      // ── Fast-path: Agent has real data from a tool but hasn't published
      // a report yet. Instead of a full reflection LLM call (±3s), inject a
      // direct instruction to publish and loop back.
      const isDataTask = /report|analytics|dashboard|top\s+\d+|ranking|list|show|find|query|search|lookup|get|fetch/i.test(task.goal)
      if (!agent._reportPublishedThisTask && agent._hasRealData && isDataTask) {
        broadcastTelemetry(tenantId, 'agent.phase', { taskId: task.id, phase: 'thinking', label: 'Publishing results...' })
        execMessages.push({
          role: 'user',
          content: `You have real data from your tools. IMMEDIATELY call publish_dashboard_report with { title, df, summary } using your results. Do NOT output text — output the tool call JSON now.`
        })
        continue  // skip reflection, go straight back to tool loop
      }

      // --- LangGraph-style Reflection Phase ---
      // Instead of blindly trusting the agent is done, we explicitly evaluate its output
      broadcastTelemetry(tenantId, 'agent.phase', { taskId: task.id, phase: 'reflecting', label: 'Reflecting on progress...' })

      if (taskTimedOut) throw new AppError('TASK_TIMEOUT', `Task exceeded maximum execution time`, 408)

      // ── Hallucination guard: detect when ALL tool calls in the last loop failed ──
      const thisLoopActions = actions.slice(actionsBeforeLoop)
      const allToolsFailed = thisLoopActions.length > 0 &&
        thisLoopActions.every(a => a.output?.success === false)

      const reflectionContent = allToolsFailed
        ? `CRITICAL REFLECTION PHASE: Review your progress against the original goal: "${task.goal}".

⚠️  EVERY tool call in the last round FAILED. You CANNOT report success when no data was retrieved. You MUST:
1. Fix the errors and retry the tools with corrected inputs
2. Or report honestly that the task could NOT be completed

Do NOT fabricate data. Do NOT claim you retrieved data when all tools returned errors.

Output only "YES_FINISHED" if you actually have verified results.
Otherwise output "NO_INCOMPLETE" followed by what went wrong and how you will fix it.`
        : `CRITICAL REFLECTION PHASE: Review your progress against the original goal: "${task.goal}". 
Are you completely finished? If yes, output only exactly "YES_FINISHED". 
If no, output "NO_INCOMPLETE" followed by a brief critique of what is missing and what you must do next.`

      const reflectionResult = await complete({
        tenantId: agent.tenant_id,
        agentId: agent.id,
        messages: [
          ...execMessages, 
          { 
            role: 'user', 
            content: reflectionContent
          }
        ],
        model: agent.llm_model,
        llmConfig: agent.llm_config,
        provider: agent.llm_provider
      })
      
      totalTokens.prompt += reflectionResult.usage.prompt
      totalTokens.completion += reflectionResult.usage.completion
      totalTokens.total += reflectionResult.usage.total

      if (reflectionResult.content.trim().startsWith('YES_FINISHED')) {
        taskSatisfied = true
      } else {
        // Feed the critique back into the context so the agent tries again
        execMessages.push({ 
          role: 'user', 
          content: `Reflection Critique: ${reflectionResult.content}\n\nYou must continue working to satisfy the original goal.` 
        })
      }
    }

    // ── HITL: If task is still AWAITING_APPROVAL, skip all further processing ──
    const { rows: [postLoopTask] } = await query(
      'SELECT status FROM agent_tasks WHERE id = $1', [task.id]
    )
    if (postLoopTask?.status === 'AWAITING_APPROVAL') {
      console.log(`[Task ${task.id}] Paused for approval, deferring completion`)
      // Clear the task timeout since we're not completing yet
      clearTimeout(timeoutId)
      // Update actions in DB but leave status as AWAITING_APPROVAL
      await query(`UPDATE agent_tasks SET actions = $1 WHERE id = $2`, [JSON.stringify(actions), task.id])
      broadcastTelemetry(tenantId, 'agent.phase', { taskId: task.id, phase: 'awaiting_approval', label: 'Waiting for human approval...' })
      return { success: true, awaiting_approval: true }
    }

    // 8. Synthesise final result — stream tokens
    // ── Failure gate: if EVERY action failed and no report was published,
    // skip the synthesis LLM call. Small models hallucinate "Synthesised
    // Results" even when all tools returned errors. ──
    // ── Category-based filtering (replaces hardcoded name exclusions).
    // DATA + SCHEMA are "data-gathering" — everything else is provisioning,
    // publishing, delegation, etc. which don't count toward data results.
    const DATA_CATEGORIES = new Set([TOOL_CATEGORY.DATA, TOOL_CATEGORY.SCHEMA])
    const dataTools = actions.filter(a => DATA_CATEGORIES.has(a.output?.category))
    const allDataToolsFailed = dataTools.length > 0 && dataTools.every(a => a.output?.success === false)
    // ── Vacuous success detection: tools returned success:true but no structured data ──
    const anyToolReturnedRows = dataTools.some(a => a.output?.hasStructuredData === true)
    // ── Goal-level intent detection (post-hoc — used for reporting/artifacts, not prompt injection)
    //     Defined at OUTER scope so reportIsWorthSaving() and data-model artifact code can both access it.
    const isDataModelGoal = /data\s*model|er\s*diagram|entity\s*relationship|schema\s*doc|database\s*design|db\s*design|table\s*relationship|data\s*modeling|data\s*modelling|relational\s*model|db\s*doc|database\s*doc|ddl|data\s*dictionary|schema\s*report/i.test(task.goal)
    const effectivelyFailed = allDataToolsFailed || (!anyToolReturnedRows && dataTools.length > 0)
    // ── Catch when EVERY action was non-DATA (provisioning, delegation, etc.)
    // and they all failed. dataTools is empty → would fall through to LLM hallucination. ──
    const allActionsFailed = actions.length > 0 && actions.every(a => a.output?.success === false)
    const reallyFailed = effectivelyFailed || (dataTools.length === 0 && allActionsFailed)
    const noReportPublished = !agent._reportPublishedThisTask

    // Skip synthesis if the agent already published a dashboard report — the
    // report IS the output. This saves an unnecessary LLM round-trip (±3s).
    broadcastTelemetry(tenantId, 'agent.phase', { taskId: task.id, phase: 'synthesising', label: 'Synthesising results...' })

    if (taskTimedOut) throw new AppError('TASK_TIMEOUT', `Task exceeded maximum execution time`, 408)

    let synthesisContent
    if (agent._reportPublishedThisTask) {
      synthesisContent = 'Report published to dashboard. See the dashboard report for full results.'
    } else if (agent._ranQuerySuccessfully && agent._lastQueryRows?.length > 0) {
      // ════════════════════════════════════════════════════════════════════
      // Data was retrieved but no report published — skip LLM synthesis
      // to prevent hallucination. Show the actual data directly.
      // ════════════════════════════════════════════════════════════════════
      const rows = agent._lastQueryRows
      const cols = agent._lastQueryColumns || Object.keys(rows[0])
      const preview = rows.slice(0, 10)
      synthesisContent = `✅ **Data Retrieved** — ${rows.length} rows from the database.\n\nColumns: ${cols.join(', ')}\n\nFirst ${preview.length} rows:\n\`\`\`json\n${JSON.stringify(preview, null, 2)}\n\`\`\`\n\n${rows.length > 10 ? `... and ${rows.length - 10} more rows. Click the execution trace to see full results.` : ''}`
    } else if (reallyFailed && noReportPublished) {
      // ════════════════════════════════════════════════════════════════════
      // ALL tools genuinely failed OR returned vacuous success (succeeded
      // structurally but produced no real data rows). Do NOT call the LLM
      // for synthesis — it will hallucinate. Output an honest summary.
      // ════════════════════════════════════════════════════════════════════
      if (allDataToolsFailed) {
        // ── Genuine tool failures: every tool returned success:false ──
        const failureSummary = actions.slice(-6).map(a => {
          const err = a.output?.error || 'unknown error'
          return `- ${a.skill}: ${typeof err === 'string' ? err.slice(0, 200) : JSON.stringify(err).slice(0, 200)}`
        }).join('\n')
        const dbToolsUsed = actions.some(a =>
          ['listTables', 'describeTable', 'runQuery', 'listDatabases', 'useDatabase'].includes(a.skill)
        )
        const advice = dbToolsUsed
          ? `\n\nThe database queries returned errors. This may indicate:\n- Incorrect table/column names (check the schema above)\n- The database is not accessible\n- The query syntax is invalid\n\nPlease review the schema and retry with corrected SQL.`
          : `\n\nThe tools returned errors. This may indicate:\n- The tool is misconfigured (e.g. wrong path, missing credentials, expired tokens)\n- The target resource is not accessible (permissions, network, API limits)\n- The agent lacks the required scopes or approvals\n\nCheck the agent's connector configuration and try again.`
        synthesisContent = `⚠️  Task could not be completed. All data-gathering attempts failed:\n\n${failureSummary || 'No data was retrieved.'}${advice}`
      } else {
        // ── Vacuous success: tools returned success:true but produced no
        // structured data (e.g. http_request to example.com returned HTML,
        // create_agent created an agent but that's not queryable data, etc.)
        const toolSummary = actions.slice(-6).map(a => {
          if (!a.output?.success) {
            const err = a.output?.error || 'unknown error'
            return `- ${a.skill}: FAILED — ${typeof err === 'string' ? err.slice(0, 150) : JSON.stringify(err).slice(0, 150)}`
          }
          // Succeeded but no structured data — describe what it actually did
          if (a.output?.created) return `- ${a.skill}: ✅ Created resource (${a.output.name || a.output.message?.slice(0, 80) || 'done'})`
          if (a.output?.agent_id) return `- ${a.skill}: ✅ Created agent "${a.output.name || a.output.agent_id}"`
          if (a.output?.status >= 200 && a.output?.status < 300) return `- ${a.skill}: ✅ HTTP ${a.output.status} — returned HTML page (not structured data)`
          if (a.skill === 'http_request') return `- ${a.skill}: ✅ Request completed but returned ${typeof a.output?.data === 'string' ? 'text' : 'non-tabular'} data (not queryable rows)`
          return `- ${a.skill}: ✅ Completed but no structured data rows returned`
        }).join('\n')
        const dbToolsUsed = actions.some(a =>
          ['listTables', 'describeTable', 'runQuery', 'listDatabases', 'useDatabase'].includes(a.skill)
        )
        const advice = dbToolsUsed
          ? `\n\nThe tools ran but didn't retrieve queryable data. Try calling runQuery with a specific SQL query to get actual rows.`
          : `\n\n⚠️  The tools ran successfully but none returned structured data (rows, tables, query results). To get real data:\n- For database tasks: use listTables → describeTable → runQuery\n- For web/API tasks: use http_request with a real API endpoint that returns JSON\n- For files: use local_dir__list → local_dir__read to get file contents\n\nAvoid calling http_request on placeholder domains like example.com — they don't contain real data.`
        synthesisContent = `⚠️  No structured data was retrieved — tools ran but produced no queryable results:\n\n${toolSummary || 'No data was retrieved.'}${advice}`
      }
    } else {
      // ════════════════════════════════════════════════════════════════════
      // Normal synthesis path: some tools returned real data or schema info.
      // Run the LLM for a narrative summary, then score for hallucinations.
      // ════════════════════════════════════════════════════════════════════
      // Count how many ACTUALLY successful data-gathering tools were called.
      // This determines whether the synthesis prompt should be honest vs
      // invite-description (which leads to hallucination in small models).
      // Use anyToolReturnedRows (computed above) instead of just success:true
      // to avoid treating vacuous successes (example.com HTML, empty searches)
      // as "real results".
      const successfulDataActions = dataTools.filter(a => a.output?.success === true)
      const hasRealResults = anyToolReturnedRows

      // ── Config-driven: only ask for data model summary when the agent
      // actually has a DB connection. Without DB, this primes hallucination.
      // Also check if the agent actually called DB tools successfully.
      const hasDb = !!agent._dbConnectionString
      const dbToolsCalled = actions.some(a =>
        ['listTables', 'describeTable', 'runQuery'].includes(a.skill) && a.output?.success
      )

      // ── Extract actual data from successful tool outputs for synthesis ──
      let dataExcerpt = ''
      if (hasRealResults) {
        const lastDataAction = successfulDataActions[successfulDataActions.length - 1]
        const rows = lastDataAction.output?.rows
        const columns = lastDataAction.output?.columns || lastDataAction.output?.fields
        const rowCount = lastDataAction.output?.row_count || (rows?.length || 0)
        if (rows && Array.isArray(rows) && rows.length > 0) {
          // Show first 5 rows as concrete examples, then summarise
          const sample = rows.slice(0, 5)
          const total = rows.length
          dataExcerpt = `\n\n📊 REAL DATA (from ${lastDataAction.skill}): ${total} rows, columns: [${(columns || Object.keys(rows[0])).join(', ')}]\nFirst ${sample.length} rows:\n${JSON.stringify(sample, null, 2)}\n${total > 5 ? `... and ${total - 5} more rows.` : ''}`
        } else if (typeof lastDataAction.output === 'object') {
          const { rows: _, columns: __, row_count: ___, success: ____, elapsed_ms: _____, _fromSchemaCache: ______, _fromCache: _______, ...rest } = lastDataAction.output
          const summary = JSON.stringify(rest).slice(0, 500)
          if (summary.length > 10) dataExcerpt = `\n\n📊 REAL DATA (from ${lastDataAction.skill}): ${summary}`
        }
      }

      const synthMsg = (isDataModelGoal && hasDb && dbToolsCalled)
        ? `SYNTHESIS PHASE — NO TOOLS AVAILABLE. You have gathered schema information from the database. Your task was to create a data model / ER diagram.

Provide a comprehensive data model summary including:
1. A complete list of tables/entities and their columns with data types
2. All foreign key relationships between tables
3. The cardinality of each relationship (1:1, 1:N, N:M)
4. Key design observations (normalization, indexing strategy, potential improvements)

If the ER diagram was generated as an HTML artifact, mention the artifact download URL. Do NOT output JSON tool calls or markdown code fences — just the data model documentation.`
        : hasRealResults
          ? `SYNTHESIS PHASE — NO TOOLS AVAILABLE. ${dataExcerpt}

⚠️  CRITICAL: You MUST ONLY report numbers, names, and values that appear in the REAL DATA above or in the tool outputs from the conversation. If you reference a customer ID, company name, or dollar amount, it MUST be copied verbatim from the actual data. DO NOT invent placeholder values like "Customer ID: 123" or "$100,000" — if the data doesn't contain those exact values, you are hallucinating.

Provide a concise summary of what was accomplished and the key findings from the data. If a chart/report was published, mention it.`
          : `SYNTHESIS PHASE — NO TOOLS AVAILABLE. ⚠️  IMPORTANT: You have NOT successfully retrieved any data from your tools. DO NOT fabricate results or describe things you "would" create. If you have no real data to report, you MUST say: "The task could not be completed — no data was successfully retrieved." Then briefly explain why each tool call failed or returned no usable data. Do NOT invent a narrative about what you "implemented" or "created" or "deployed" — that would be a hallucination.`
      const synthesis = await completeStream({
        tenantId: agent.tenant_id,
        agentId: agent.id,
        messages: [...execMessages, { role: 'user', content: synthMsg }],
        model: agent.llm_model,
        llmConfig: agent.llm_config,
        provider: agent.llm_provider,
        onToken: (token) => {
          broadcastTelemetry(tenantId, 'agent.token', { taskId: task.id, phase: 'synthesising', token })
        }
      })
      totalTokens.total += synthesis.usage.total
      synthesisContent = synthesis.content

      // ════════════════════════════════════════════════════════════════════
      // Hallucination filter with scoring — detects fabricated synthesis
      // across ALL agent types (trained, standard, DB, non-DB).
      //
      // Score: 100 = clean, 0 = definitely hallucinated. Score represents
      // our confidence that the synthesis is based on real data/tools.
      // ════════════════════════════════════════════════════════════════════
      if (synthesisContent && typeof synthesisContent === 'string') {
        const txt = synthesisContent
        let hallucinationScore = 100  // start clean, deduct for each red flag

        // ── Pattern libraries ──────────────────────────────────────────
        const actionPhrases = [
          'I implemented', 'I created', 'I developed', 'I built',
          'I tested', 'I refined', 'I finalized', 'I deployed',
          'I generated', 'I designed', 'after testing', 'after implementing',
          'has significantly improved', 'ultimately enhancing',
          'enabling healthcare', 'the resulting', 'was functioning as expected',
          'the dashboard report provided', 'visualizations that facilitated',
        ]
        const dataModelHallucinationPatterns = [
          'Data Model Summary', 'Database Schema', 'Table Structures',
          'Entity-Relationship', 'ER Diagram', 'Foreign Key Relationships',
          'Primary Keys:', 'column_name', 'data_type',
          'Based on my understanding of the project',
          'Based on the database schema',
        ]
        const futureDescriptionPatterns = [
          'I will provide', 'I will focus on', 'I will implement',
          'I will create', 'I will develop', 'I will add',
          'I will continue', 'I will need to',
          'is not yet complete', 'is not yet implemented',
          'lacks the following', 'are missing',
          'not yet been implemented', 'not yet complete',
          'does not allow for', 'do not have any associated',
          'the current implementation', 'currently lacks',
          'To complete the', 'To finish the',
          'features are missing', 'functionality is missing',
          'has not been implemented', 'have not been added',
          'would need to', 'should be implemented',
          'a revised response', 'in the correct format',
        ]
        // ── NEW: Generic hallucination markers for standard models ──────
        const genericHallucinationPatterns = [
          'the analysis reveals', 'the data shows that', 'our findings indicate',
          'according to the data', 'the results demonstrate', 'the query returned',
          'I queried the', 'I retrieved the data', 'the database contains',
          'after analyzing', 'the report includes', 'key insights include',
          'the dashboard displays', 'the chart illustrates',
          'I successfully', 'I have successfully',
        ]

        const dataModelHallucinationCount = dataModelHallucinationPatterns.filter(p => txt.includes(p)).length
        const futureDescriptionCount = futureDescriptionPatterns.filter(p => txt.includes(p)).length
        const fabricationCount = actionPhrases.filter(p => txt.includes(p)).length + dataModelHallucinationCount + futureDescriptionCount

        // ── Generic hallucination: claiming data analysis when no tools ran ──
        const genericHallucinationHits = genericHallucinationPatterns.filter(p => txt.includes(p)).length

        // ── Fabricated publish detection ─────────────────────────────────
        const fabricatedPublish = /published\s+a\s+(chart|report|dashboard|visualiz)/i.test(txt) && !agent._reportPublishedThisTask

        // Count real data points in the synthesis
        const hasRealNumbers = (txt.match(/\b\d{2,}\b/g) || []).length >= 2
        const hasFilePath = /\/[\w/.-]+\.\w{2,5}/.test(txt)
        const hasUrl = /https?:\/\//.test(txt)
        const hasCodeBlock = /```[\s\S]*```|<svg\b|<script\b|<canvas\b|<path\b/.test(txt)
        const hasDataRows = /\|.+\|.+\|/.test(txt)
        const hasActualContent = hasRealNumbers || hasFilePath || hasUrl || hasCodeBlock || hasDataRows

        // Also flag fake dollar amounts or IDs not in real data
        let hasFakeNumbers = false
        if (hasRealResults && txt.match(/\$\d{1,3}(,\d{3})*(\.\d+)?/)) {
          const lastDataRows = successfulDataActions[successfulDataActions.length - 1]?.output?.rows
          if (lastDataRows && Array.isArray(lastDataRows) && lastDataRows.length > 0) {
            const dataStr = JSON.stringify(lastDataRows.slice(0, 20))
            const dollarMatches = txt.match(/\$\d{1,3}(,\d{3})*(\.\d+)?/g) || []
            const fakeDollars = dollarMatches.filter(d => !dataStr.includes(d.replace(/[$,]/g, '')))
            if (fakeDollars.length >= 2) hasFakeNumbers = true
          }
        }

        // ── Hallucination Score Calculation ────────────────────────────
        // Deduct points for each red flag; add points for real data signals
        if (fabricationCount >= 3) hallucinationScore -= 40
        else if (fabricationCount >= 1) hallucinationScore -= 15
        if (fabricatedPublish) hallucinationScore -= 35
        if (hasFakeNumbers) hallucinationScore -= 30
        if (!hasActualContent) hallucinationScore -= 20
        if (genericHallucinationHits >= 2 && !hasRealResults) hallucinationScore -= 25
        // ── Contradiction: synthesis says "no data" but tools returned real results ──
        const synthesisClaimsNoData = /no (?:data|tables?|results?|records?|information) (?:available|found|returned|to |for )|nothing (?:was )?(?:found|returned|available)|no matching (?:data|records|results)|empty (?:result|dataset|response)|couldn't find any (?:data|results|tables)/i.test(txt)
        if (synthesisClaimsNoData && hasRealResults) hallucinationScore -= 40
        // Boost: real data signals
        if (hasActualContent) hallucinationScore = Math.min(100, hallucinationScore + 10)
        if (hasRealResults) hallucinationScore = Math.min(100, hallucinationScore + 15)
        if (agent._reportPublishedThisTask) hallucinationScore = Math.min(100, hallucinationScore + 20)

        // Clamp
        hallucinationScore = Math.max(0, Math.min(100, hallucinationScore))

        // ── Threshold: below 40 is likely hallucination ─────────────────
        const isHallucinated = hallucinationScore < 40

        if (isHallucinated) {
          const toolSummary = actions.slice(0, 8).map(a => {
            const status = a.output?.success ? '✅' : '❌'
            const detail = a.output?.error ? ` — ${a.output.error.slice(0, 80)}` : ''
            return `- ${status} ${a.skill}${detail}`
          }).join('\n')
          const reason = fabricatedPublish ? 'synthesis claimed a chart/report was published but publish_dashboard_report was never called'
            : hasFakeNumbers ? 'synthesis contained dollar amounts/IDs not found in the actual data'
            : `${fabricationCount} hallucination markers and no real data points`

          // Build an honest summary from the actual data if available
          let honestSummary = ''
          if (hasRealResults) {
            const lastAction = successfulDataActions[successfulDataActions.length - 1]
            const rowCount = lastAction.output?.row_count || lastAction.output?.rows?.length || 0
            const cols = lastAction.output?.columns || Object.keys(lastAction.output?.rows?.[0] || {})
            const firstFew = lastAction.output?.rows?.slice(0, 5)
            honestSummary = `\n\n✅ Real data was retrieved: ${rowCount} rows with columns [${cols.join(', ')}].\nSample rows:\n${JSON.stringify(firstFew, null, 2)}`
          }

          synthesisContent = `⚠️  **HALLUCINATION DETECTED** (score: ${hallucinationScore}/100) — ${reason}.${honestSummary}\n\nThe original fabricated synthesis has been suppressed.\n\nAttempted actions:\n${toolSummary || '(no tools were successfully called)'}\n\nTo fix this:\n- Check that the required connectors (database, local directory, API) are configured and accessible\n- Ensure the agent has the correct tool scopes enabled\n- Verify the task goal is achievable with the available tools`
          console.log(`[HALLUCINATION-FILTER] Rejected fabricated synthesis (score: ${hallucinationScore}) — ${reason}`)
        } else {
          console.log(`[HALLUCINATION-FILTER] Synthesis passed (score: ${hallucinationScore}/100)`)
        }
        // Store score on agent for result metadata
        agent._hallucinationScore = hallucinationScore
      } else {
        agent._hallucinationScore = 100  // no synthesis content = clean
      }
    }

    const result = {
      output: synthesisContent,
      confidence: extractConfidence(synthesisContent),
      summary: synthesisContent,
      hallucinationScore: agent._hallucinationScore ?? 100,
    }

    // Automatically publish to dashboard reports if the goal or output implies a report/analytics summary
    // Skip if the agent already called publish_dashboard_report (detected via actions array)
    try {
      const alreadyPublished = actions.some(a => a.skill === 'publish_dashboard_report' && a.output?.success)
      
      // Double-check the DB too — there may have been a report created via the tool
      // that wasn't captured in actions (edge cases with async/resume flows)
      let dbAlreadyHasReport = false
      if (alreadyPublished) {
        dbAlreadyHasReport = true
      } else {
        try {
          const { rows: recent } = await query(
            `SELECT id FROM dashboard_reports WHERE tenant_id = $1 AND agent_id = $2 AND created_at > NOW() - INTERVAL '15 seconds' LIMIT 1`,
            [agent.tenant_id, agent.id]
          )
          dbAlreadyHasReport = recent.length > 0
        } catch { /* non-critical lookup */ }
      }

      const isReportGoal = /report|analytics|dashboard|breakdown|summary|chart|metrics|kpi|insight|visual|trend|analyze|analysis/i.test(task.goal)
      
      // ══════════════════════════════════════════════════════════════════
      // Quality gate — don't save hallucinated or plan-only reports.
      // Only persists when the agent gathered real data & produced results.
      // ══════════════════════════════════════════════════════════════════
      function reportIsWorthSaving(body, synthesisText) {
        if (!body || body.length < 200) return false

        // Must have executed at least one data-gathering tool
        const dataTools = actions.filter(a =>
          a.output?.category !== TOOL_CATEGORY.PUBLISH &&
          a.output?.success
        )
        if (dataTools.length === 0) {
          console.log('[AUTO-REPORT] Skipped — no successful data-gathering tool calls')
          return false
        }

        // Synthesis must be results, not a plan.
        // For data model tasks, "next steps" and refinement language is
        // normal — data models are iterative. Only block pure planning
        // language (no actual schema data collected).
        const planMarkers = isDataModelGoal
          ? [
            /I will continue/i,
            /I need to\b/i, /I plan to\b/i, /I am going to\b/i,
          ]
          : [
            /I will continue/i, /Next [Ss]teps/i,
            /I need to\b/i, /I plan to\b/i, /I am going to\b/i,
            /To complete this/i, /remaining work/i,
            /I have not yet/i, /not yet implemented/i,
            /would need to\b/i, /should be added/i,
          ]
        if (planMarkers.some(p => p.test(synthesisText || ''))) {
          console.log('[AUTO-REPORT] Skipped — synthesis looks like a plan, not results')
          return false
        }

        // Body must contain real data (numbers, table, chart, or interactive visual)
        const hasNumbers = /\d{2,}/.test(body)
        const hasTable = /<table|<tr|<td|<th/i.test(body)
        const hasChart = /chart\.js|Chart\(|new Chart|canvas|cdn\.jsdelivr|d3\.js|d3\.select|d3\.json|<svg\b|<path\b|<circle\b|<rect\b|<g\b|<line\b|<polygon/i.test(body)
        if (!hasNumbers && !hasTable && !hasChart) {
          console.log('[AUTO-REPORT] Skipped — no data, table, or chart in report body')
          return false
        }

        // Reject if synthesis uses future-tense planning language (hallucination)
        const hallucinationMarkers = /I retrieved.*using|I used the.*function|I will create.*chart|I will add.*CSS/i
        const hallucinationCount = (synthesisText || '').match(new RegExp(hallucinationMarkers, 'gi'))?.length || 0
        if (hallucinationCount >= 2) {
          console.log('[AUTO-REPORT] Skipped — synthesis appears hallucinated (%d markers)', hallucinationCount)
          return false
        }

        return true
      }

      console.log('[AUTO-REPORT] Fallback check:', {
        alreadyPublished,
        dbAlreadyHasReport,
        isReportGoal,
        goalText: task.goal,
        hasSynthesis: !!synthesisContent,
        synthesisLength: synthesisContent?.length || 0
      })
      if (!dbAlreadyHasReport && isReportGoal && synthesisContent) {
        // Use task goal as the report title (truncated) — much more meaningful than "Report"
        const reportTitle = task.goal.slice(0, 80)
        let reportBody = synthesiseReportHtml(synthesisContent)

        // If the synthesis didn't contain usable HTML, ask the LLM to generate
        // clean HTML only — no reasoning, no logs, no markdown fences.
        if (!reportBody) {
          // ── Detect task type for smarter HTML generation ────────────────
          const isVisTask = /chart|diagram|visual|interactive|d3|svg|plot|graph|drawing|floorplan|blueprint|floor.plan|beam|schematic|architect|ecg|circuit|anatomical|layout/i.test(task.goal)
          const visHint = isVisTask
            ? `\n\n⚠️  CRITICAL: This task is about a VISUAL chart/diagram. You MUST generate actual interactive code — SVG markup, D3.js script, or Chart.js canvas. Do NOT describe what a chart "would look like" or write prose ABOUT the chart. Generate the REAL thing. For SVG: output raw <svg>...</svg> tags. For D3: include <script src="https://d3js.org/d3.v7.min.js"></script> and the D3 code. For Chart.js: include the canvas element and new Chart() code. The report will FAIL validation if it contains only descriptive text without actual visual markup.`
            : ''
          const htmlGen = await complete({
            tenantId: agent.tenant_id,
            agentId: agent.id,
            messages: [
              ...execMessages,
              { role: 'assistant', content: synthesisContent },
              { role: 'user', content: `The task requires a dashboard report. Original goal: "${task.goal}".${visHint}\n\nBased on the data and results above, generate ONLY the complete HTML report content. Do NOT include any explanation, summary, reasoning, or markdown code fences. Output ONLY the raw HTML starting with <div> and ending with </div>. Use inline CSS for styling and include Chart.js from https://cdn.jsdelivr.net/npm/chart.js for any charts. For SVG diagrams, embed raw <svg> tags directly. For D3.js, include the D3 library and render code.` }
            ],
            model: agent.llm_model,
            llmConfig: agent.llm_config,
            provider: agent.llm_provider
          })
          totalTokens.prompt += htmlGen.usage.prompt
          totalTokens.completion += htmlGen.usage.completion
          totalTokens.total += htmlGen.usage.total
          reportBody = synthesiseReportHtml(htmlGen.content) || markdownToReportHtml(htmlGen.content)
        }

        if (reportBody && reportIsWorthSaving(reportBody, synthesisContent)) {
          const htmlContent = `
            <div style="font-family: system-ui, sans-serif; padding: 20px; background: #ffffff; border-radius: 12px; color: #1e293b; border: 1px solid #e2e8f0;">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; border-bottom: 1px solid #f1f5f9; padding-bottom: 12px;">
                <div>
                  <h2 style="font-size: 18px; font-weight: 700; color: #0f172a; margin: 0;">${reportTitle}</h2>
                  <p style="font-size: 12px; color: #64748b; margin: 4px 0 0 0;">Generated by ${agent.name} • ${new Date().toLocaleDateString()}</p>
                </div>
                <span style="background: #e0f2fe; color: #0369a1; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600;">Live Report</span>
              </div>
              ${reportBody}
            </div>
          `
          await saveReport(agent.tenant_id, agent.id, reportTitle, htmlContent)
        }
      }
    } catch (reportErr) {
      console.warn('Auto-report generation warning:', reportErr.message)
    }

    // ── Data model artifact generation ────────────────────────────────────
    // If the task is a data model goal and the agent gathered schema data,
    // generate a Mermaid ERD from the collected table schemas and save it.
    try {
      const dataModelActions = actions.filter(a =>
        (a.skill === 'describeTable' || a.skill === 'listTables') && a.output?.success
      )
      const alreadyHasArtifact = actions.some(a =>
        a.skill === 'write_artifact' && (a.output?.success || a.output?.message)
      )
      if (isDataModelGoal && dataModelActions.length > 0 && !alreadyHasArtifact) {
        console.log('[DATA-MODEL] Generating ERD artifact from collected schema data...')
        // Collect unique tables with their schemas from describeTable results
        const tableSchemas = new Map()
        for (const a of dataModelActions) {
          const out = a.output
          if (out.table && out.columns) {
            const key = out.table
            if (!tableSchemas.has(key)) {
              tableSchemas.set(key, {
                table: out.table,
                columns: out.columns || [],
                foreignKeys: out.foreignKeys || [],
                referencedBy: out.referencedBy || [],
              })
            }
          }
          // Also collect from listTables (just table names, no columns)
          if (out.tables && Array.isArray(out.tables)) {
            for (const t of out.tables) {
              const key = `${t.table_schema || 'public'}.${t.table_name}`
              if (!tableSchemas.has(key)) {
                tableSchemas.set(key, {
                  table: key,
                  columns: [],
                  foreignKeys: [],
                  referencedBy: [],
                })
              }
            }
          }
        }

        if (tableSchemas.size > 0) {
          // Build Mermaid ERD
          let mermaid = 'erDiagram\n'
          const allFks = []

          for (const [, schema] of tableSchemas) {
            const [schemaName, tableName] = schema.table.split('.')
            const entityName = tableName.replace(/[^a-zA-Z0-9_]/g, '_')
            mermaid += `  ${entityName} {\n`

            if (schema.columns.length > 0) {
              for (const col of schema.columns) {
                const colType = (col.data_type || 'varchar').toUpperCase()
                const pk = col.column_name === 'id' || col.column_default?.includes('uuid') ? ' PK' : ''
                const fk = col.is_nullable === 'NO' ? ' NOT NULL' : ''
                const colName = col.column_name.replace(/[^a-zA-Z0-9_]/g, '_')
                mermaid += `    ${colType} ${colName}${pk}${fk}\n`
              }
            } else {
              mermaid += `    varchar placeholder "call describeTable for details"\n`
            }

            mermaid += '  }\n'

            // Collect FK relationships
            for (const fk of (schema.foreignKeys || [])) {
              const refTable = (fk.foreign_table || fk.referenced_table || '').replace(/[^a-zA-Z0-9_]/g, '_')
              if (refTable && refTable !== entityName) {
                allFks.push(`  ${entityName} ||--o{ ${refTable} : "${fk.column_name || 'FK'}"`)
              }
            }
            // Also from referencedBy
            for (const rev of (schema.referencedBy || [])) {
              const srcTable = (rev.source_table || '').replace(/[^a-zA-Z0-9_]/g, '_')
              if (srcTable && srcTable !== entityName) {
                allFks.push(`  ${srcTable} }o--|| ${entityName} : "${rev.column_name || 'FK'}"`)
              }
            }
          }

          if (allFks.length > 0) {
            mermaid += '\n' + [...new Set(allFks)].join('\n') + '\n'
          }

          console.log('[DATA-MODEL] Built ERD with %d entities and %d relationships', tableSchemas.size, allFks.length)

          // Save as an artifact via the write_artifact handler
          const mermaidHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Data Model — ${task.goal.slice(0, 60)}</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<style>
  body { font-family: system-ui, sans-serif; padding: 20px; background: #f8fafc; color: #1e293b; }
  h1 { font-size: 20px; margin-bottom: 8px; }
  .meta { color: #64748b; font-size: 12px; margin-bottom: 24px; }
  .mermaid { background: #fff; border-radius: 12px; padding: 24px; border: 1px solid #e2e8f0; overflow-x: auto; }
  .info { margin-top: 20px; padding: 12px; background: #f0f9ff; border-radius: 8px; font-size: 13px; }
</style>
</head>
<body>
<h1>📐 Data Model: ${task.goal.slice(0, 80)}</h1>
<p class="meta">Generated by ${agent.name} • ${new Date().toLocaleDateString()} • ${tableSchemas.size} entities, ${allFks.length} relationships</p>
<div class="mermaid">
${mermaid}
</div>
<div class="info">
  <strong>Entities:</strong> ${[...tableSchemas.keys()].join(', ')}<br>
  <strong>Relationships:</strong> ${allFks.length > 0 ? allFks.length + ' foreign key relationships detected' : 'No foreign keys defined in schema'}
</div>
<script>mermaid.initialize({ startOnLoad: true, theme: 'default' });</script>
</body>
</html>`

          // Call write_artifact inline
          const saved = await (async () => {
            try {
              const { writeFile, mkdir } = await import('node:fs/promises')
              const { join } = await import('node:path')
              const artifactsDir = join(process.cwd(), '..', '..', 'artifacts', agent.tenant_id, new Date().toISOString().slice(0, 10))
              await mkdir(artifactsDir, { recursive: true })
              const sanitise = (s) => s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
              const fname = sanitise(`data-model-${Date.now()}.html`)
              const filePath = join(artifactsDir, fname)
              await writeFile(filePath, mermaidHtml, 'utf-8')
              return { success: true, downloadUrl: `/api/v1/artifacts/${agent.tenant_id}/${fname}` }
            } catch (e) { return { success: false, error: e.message } }
          })()

          // Append a pseudo-action so the UI knows an artifact was generated
          if (saved.success) {
            actions.push({
              skill: 'write_artifact',
              input: { format: 'html', filename: 'data-model.html' },
              output: { success: true, message: 'Data model ERD generated', downloadUrl: saved.downloadUrl },
              at: new Date().toISOString()
            })
            console.log('[DATA-MODEL] Artifact saved:', saved.downloadUrl)
          }
        } else {
          console.log('[DATA-MODEL] No table schemas collected — skipping ERD generation')
        }
      }
    } catch (dataModelErr) {
      console.warn('[DATA-MODEL] Artifact generation failed:', dataModelErr.message)
    }

    // 8. Mark complete FIRST — before non-critical post-processing (memory,
    // telemetry, audit). If any of those hang, the task is already COMPLETED
    // and won't stay stuck in RUNNING.
    await query(
      `UPDATE agent_tasks SET status = 'COMPLETED', result = $1, actions = $2, token_usage = $3, completed_at = NOW() WHERE id = $4 AND tenant_id = $5`,
      [result, JSON.stringify(actions), JSON.stringify(totalTokens), task.id, tenantId]
    )

    // 9. Post-processing (fire-and-forget — failures are logged, not fatal)
    try { await saveEpisodicMemory(agent, task, result, actions) } catch (e) { console.warn(`[Task ${task.id}] Episodic memory save failed:`, e.message) }
    try { await extractAndStoreMemory(agent.id, tenantId, task.id, synthesisContent, agent.llm_config, agent.llm_provider) } catch (e) { console.warn(`[Task ${task.id}] Entity memory extract failed:`, e.message) }
    try {
      broadcastTelemetry(tenantId, 'agent.task_completed', { taskId: task.id, agentId: agent.id, confidence: result.confidence, tokensUsed: totalTokens.total, durationMs: Date.now() - startTime })
    } catch { /* non-critical */ }
    try {
      await auditLog({ eventType: 'agent.task_completed', tenantId, actorId: agent.id, actorType: 'AGENT', resourceType: 'AgentTask', resourceId: task.id, action: 'COMPLETE_TASK', afterState: { status: 'COMPLETED', tokensUsed: totalTokens.total, actionsCount: actions.length, durationMs: Date.now() - startTime } })
    } catch { /* non-critical */ }

    clearTimeout(timeoutId)

  } catch (err) {
    clearTimeout(timeoutId)
    // Mark FAILED FIRST — before telemetry/audit, so the task isn't stuck if they hang.
    await query(
      `UPDATE agent_tasks SET status = 'FAILED', error = $1, actions = $2, token_usage = $3, completed_at = NOW() WHERE id = $4 AND tenant_id = $5`,
      [err.message, JSON.stringify(actions), JSON.stringify(totalTokens), task.id, tenantId]
    )
    try { broadcastTelemetry(tenantId, 'agent.task_failed', { taskId: task.id, agentId: agent.id, error: err.message }) } catch {}
    try {
      await auditLog({ eventType: 'agent.task_failed', tenantId, actorId: agent.id, actorType: 'AGENT', resourceType: 'AgentTask', resourceId: task.id, action: 'FAIL_TASK', afterState: { status: 'FAILED', error: err.message.slice(0, 500), actionsCount: actions.length, tokensUsed: totalTokens.total, durationMs: Date.now() - startTime } })
    } catch { /* non-critical */ }
    throw err
  }
}

// ─── Knowledge / Report / Prompt functions moved to task-knowledge.js and task-reports.js ──



async function executeTool(toolName, input, agent, skills) {
  // ── Normalise snake_case → camelCase (small models hallucinate underscores) ──
  const TOOL_ALIASES = {
    // snake_case → camelCase (small models love underscores)
    'list_tables': 'listTables',
    'describe_table': 'describeTable',
    'run_query': 'runQuery',
    'list_databases': 'listDatabases',
    'use_database': 'useDatabase',
    'http_request': 'http_request',
    'run_skill': 'runSkill',
    // User prompt friendly names → actual tools (from agent system prompts)
    'list_files': 'local_dir__list',
    'read_file': 'local_dir__read',
    'write_file': 'local_dir__write',
    'query': 'runQuery',
    'web_search': 'http_request',
    // ⚠️  publish_dashboard_report and write_artifact use underscore form
    // for BOTH tool definitions AND dispatch checks — do NOT normalize
    // them to camelCase. camelCase → underscore aliases for robustness:
    'publishDashboardReport': 'publish_dashboard_report',
    'writeArtifact': 'write_artifact',
    'createConnector': 'create_connector',
    // These are already in canonical form — leave unchanged
    'local_dir__list': 'local_dir__list',
    'local_dir__read': 'local_dir__read',
    'local_dir__write': 'local_dir__write',
    'local_shell__execute': 'local_shell__execute',
    'publish_dashboard_report': 'publish_dashboard_report',
    'write_artifact': 'write_artifact',
    'create_connector': 'create_connector',
    'search_graph': 'searchGraph',
  }
  const originalName = toolName
  toolName = TOOL_ALIASES[toolName] || toolName
  if (toolName !== originalName) {
    console.log(`[ToolAlias] Normalised "${originalName}" → "${toolName}"`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DB-trained model lightweight tools — same pattern as chat.service.js
  // Handles listDatabases/useDatabase/listTables/describeTable/runQuery
  // via a raw PG connection.
  // ═══════════════════════════════════════════════════════════════════════════
  const rawDb = (
    toolName === 'listDatabases' || toolName === 'useDatabase' ||
    toolName === 'listTables' || toolName === 'describeTable' || toolName === 'runQuery'
  )
    ? agent._dbConnectionString || null
    : null

  if (rawDb) {
    const connectionMap = agent._dbConnectionMap || null

    // ── Multi-DB tools ───────────────────────────────────────────────────
    if (toolName === 'listDatabases') {
      if (!connectionMap) {
        return { success: false, error: 'No multi-database configuration found. This agent is connected to a single database.' }
      }
      const dbs = [...connectionMap.entries()].map(([label, cfg]) => ({
        label,
        dbType: cfg.dbType,
      }))
      return { success: true, databases: dbs, count: dbs.length }
    }

    if (toolName === 'useDatabase') {
      if (!input.database) {
        return { success: false, error: 'database label is required. Call listDatabases to see available databases.' }
      }
      if (!connectionMap) {
        return { success: false, error: 'No multi-database configuration found. This agent is connected to a single database.' }
      }
      const target = connectionMap.get(input.database)
      if (!target) {
        const available = [...connectionMap.keys()].join(', ')
        return { success: false, error: `Unknown database: "${input.database}". Available: ${available}` }
      }
      // Mutate the agent's active connection
      agent._dbConnectionString = target.connectionString
      return {
        success: true,
        switched: true,
        database: input.database,
        dbType: target.dbType,
      }
    }

    // ── Single-DB tools (use current connection) ──────────────────────────
    let sql = null  // hoisted for shared catch block (runQuery populates it)
    try {
      const pg = await import('pg').then(m => m.default || m)
      const client = new pg.Client(rawDb)

      if (toolName === 'listTables') {
        // ── Schema preloaded: return cached data without DB round-trip ──
        if (agent._schemaPreloaded && agent._schemaText) {
          const tableNames = agent._schemaText
            .split('\n')
            .filter(l => /^\s{2}\w+\.\w+\s*\(/.test(l))
            .map(l => {
              const m = l.match(/^\s{2}(\w+)\.(\w+)\s*\(/)
              return m ? { table_schema: m[1], table_name: m[2] } : null
            })
            .filter(Boolean)
          if (tableNames.length > 0) {
            return { success: true, tables: tableNames, count: tableNames.length, _fromSchemaCache: true }
          }
        }
        const cacheKey = `dbschema:${hashKey(rawDb)}:listTables`
        return cached(cacheKey, async () => {
          await client.connect()
          const { rows } = await client.query(
            `SELECT table_schema, table_name FROM information_schema.tables
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
             ORDER BY table_schema, table_name`
          )
          await client.end().catch(() => {})
          return { success: true, tables: rows, count: rows.length }
        }, 300)  // 5 min TTL — schema rarely changes
      }

      if (toolName === 'describeTable') {
        // ── Normalize table name: "public.customers" → schema="public", table="customers" ──
        // Accept "db" as an alias for "table" — small LLMs frequently hallucinate this param name
        let schema = input.schema || 'public'
        let tableName = input.table || input.db
        if (tableName && tableName.includes('.')) {
          const parts = tableName.split('.')
          if (parts.length === 2) {
            schema = parts[0]
            tableName = parts[1]
          }
        }
        if (!tableName) {
          // ── Schema preloaded & no table specified: return full table list ──
          if (agent._schemaPreloaded && agent._schemaText) {
            const tables = agent._schemaText
              .split('\n')
              .filter(l => /^\s{2}\w+\.\w+\s*\(/.test(l))
              .map(l => {
                const m = l.match(/^\s{2}(\w+)\.(\w+)\s*\(([^)]+)\)(.*)/)
                if (!m) return null
                const cols = m[3].split(', ').length
                const fkHint = m[4].includes('JOINS TO') ? m[4].trim() : ''
                return { table_schema: m[1], table_name: m[2], column_count: cols, join_hint: fkHint || undefined }
              })
              .filter(Boolean)
            return {
              success: true,
              error: null,
              hint: 'No table name provided. Here are all available tables. Call describeTable with { table: "table_name" } to see columns for a specific table.',
              tables,
              _fromSchemaCache: true,
            }
          }
          return { success: false, error: 'table name is required. Pass it as "table". Example: { "table": "orders" }. Call listTables first if you don\'t know the table names.' }
        }
        // ── Schema preloaded: parse column info from preloaded text ──
        if (agent._schemaPreloaded && agent._schemaText) {
          const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const rx = new RegExp(`^\\s{2}${schema}\\.${escapedTable}\\s*\\(([^)]+)\\)`)
          for (const line of agent._schemaText.split('\n')) {
            const m = line.match(rx)
            if (m) {
              const cols = m[1].split(', ').map(c => {
                const [name, type] = c.split(':')
                return { column_name: name, data_type: type || 'unknown' }
              })
              // Parse FK hints from the same line
              const fkMatch = line.match(/JOINS TO: (.+)/)
              const foreignKeys = fkMatch ? fkMatch[1].split(', ').map(f => {
                const parts = f.match(/(\w+)\s*→\s*(\w+)\((\w+)\)/)
                return parts ? { column_name: parts[1], foreign_table: parts[2], foreign_column: parts[3] } : null
              }).filter(Boolean) : []
              return {
                table: `${schema}.${tableName}`,
                columns: cols,
                ...(foreignKeys.length > 0 ? { foreignKeys } : {}),
                _fromSchemaCache: true,
              }
            }
          }
        }
        const cacheKey = `dbschema:${hashKey(rawDb)}:desc:${schema}:${tableName}`
        return cached(cacheKey, async () => {
          await client.connect()
          const { rows: cols } = await client.query(
            `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
            [schema, tableName]
          )
          // Fetch foreign-key relationships so the model can write JOINs
          let foreignKeys = []
          try {
            const { rows: fks } = await client.query(
              `SELECT
                 kcu.column_name,
                 ccu.table_schema AS foreign_schema,
                 ccu.table_name AS foreign_table,
                 ccu.column_name AS foreign_column
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
               JOIN information_schema.constraint_column_usage ccu
                 ON tc.constraint_name = ccu.constraint_name
                 AND tc.table_schema = ccu.table_schema
               WHERE tc.constraint_type = 'FOREIGN KEY'
                 AND tc.table_schema = $1
                 AND tc.table_name = $2`,
              [schema, tableName]
            )
            foreignKeys = fks
          } catch { /* FK lookup is best-effort */ }
          // Also get referenced-by info (reverse FKs)
          let referencedBy = []
          try {
            const { rows: revs } = await client.query(
              `SELECT
                 kcu.column_name,
                 kcu.table_schema AS source_schema,
                 kcu.table_name AS source_table
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
               JOIN information_schema.constraint_column_usage ccu
                 ON tc.constraint_name = ccu.constraint_name
               WHERE tc.constraint_type = 'FOREIGN KEY'
                 AND ccu.table_schema = $1
                 AND ccu.table_name = $2`,
              [schema, tableName]
            )
            referencedBy = revs
          } catch { /* reverse FK lookup is best-effort */ }
          let sample = null
          try {
            const { rows: r } = await client.query(
              `SELECT * FROM "${schema}"."${tableName}" LIMIT 3`
            )
            sample = r
          } catch { /* ignore sample errors */ }
          await client.end().catch(() => {})
          return {
            success: true,
            table: `${schema}.${tableName}`,
            columns: cols,
            ...(foreignKeys.length > 0 ? { foreignKeys } : {}),
            ...(referencedBy.length > 0 ? { referencedBy } : {}),
            sample,
          }
        }, 300)  // 5 min TTL — schema rarely changes
      }

      if (toolName === 'runQuery') {
        // Accept multiple parameter name aliases — small models often get confused
        sql = input.sql || input.query || input.queryString || input.dbSql || input.query_sql
        if (!sql) {
          // Check if they passed something else — give a helpful correction
          const passedKeys = Object.keys(input || {}).filter(k => input[k] !== undefined && input[k] !== '')
          const hint = passedKeys.length > 0
            ? `You passed "${passedKeys[0]}" but the parameter must be named "sql". Try: { "sql": "SELECT COUNT(*) FROM orders" }`
            : `Pass your SQL as the "sql" parameter. Example: { "sql": "SELECT * FROM customers LIMIT 10" }`
          return { success: false, error: `❌ sql is required. ${hint}` }
        }
        const trimmed = sql.trim()
        const upper = trimmed.toUpperCase()
        const isSelect = upper.startsWith('SELECT') || (upper.startsWith('WITH') && /\bSELECT\b/.test(upper))
        if (!isSelect) return { success: false, error: 'Only SELECT queries are allowed.' }
        let finalSql = trimmed
        if (!upper.includes('LIMIT')) finalSql = `${trimmed}\nLIMIT 200`
        const cacheKey = `dbsql:${hashKey(rawDb, finalSql)}`
        const queryResult = await cached(cacheKey, async () => {
          await client.connect()
          const start = Date.now()
          const result = await client.query(finalSql)
          const elapsed = Date.now() - start
          await client.end().catch(() => {})
          return {
            success: true,
            columns: result.fields.map(f => f.name),
            row_count: result.rows.length,
            elapsed_ms: elapsed,
            rows: result.rows,
          }
        }, 60)  // 60s TTL for query results
        if (queryResult.success) {
          agent._ranQuerySuccessfully = true
          agent._lastQueryRows = queryResult.rows
          agent._lastQueryColumns = queryResult.columns
        }
        return queryResult
      }
    } catch (err) {
      // Build a helpful error that includes columns from described tables
      const descTables = agent._describedTables || new Set()
      const lastDescCols = agent._lastDescribeColumns

      // Extract table names from the SQL to check which ones haven't been described
      const sqlTables = new Set()
      const tableMatch = sql ? sql.match(/\b(?:FROM|JOIN)\s+(?:public\.)?"?(\w+)"?/gi) : null
      if (tableMatch) {
        for (const m of tableMatch) {
          const t = m.replace(/^(?:FROM|JOIN)\s+(?:public\.)?"?/i, '').replace(/"$/,'').toLowerCase()
          sqlTables.add(t)
        }
      }
      const undescribed = [...sqlTables].filter(t => !descTables.has(t) && t !== 'unknown')

      // Column-specific error: suggest describing the missing table
      const isColumnError = /column.*does not exist/i.test(err.message)
      let colHint = ''
      let instruction = ''

      if (isColumnError && undescribed.length > 0) {
        colHint = `\n\n📋 You described: [${[...descTables].join(', ')}] — but you have NOT described: [${undescribed.join(', ')}]\n⚠️  Call describeTable on "${undescribed[0]}" before writing SQL that joins/uses it.`
        instruction = `Call describeTable on "${undescribed[0]}" to get its columns. Then rewrite your SQL with the correct column names.`
      } else if (isColumnError && lastDescCols?.length) {
        colHint = `\n\n📋 Columns that DO exist (from your described tables): ${lastDescCols.join(', ')}\n⚠️  Use ONLY these column names.`
        instruction = 'Rewrite your SQL using ONLY the column names listed above. If you need columns from a table you haven\'t described yet, call describeTable on it.'
      } else if (lastDescCols?.length) {
        colHint = `\n\n📋 Known columns: ${lastDescCols.join(', ')}\n⚠️  Check your SQL matches these names.`
        instruction = 'Rewrite your SQL using ONLY the column names listed above. If you need columns from a table you haven\'t described yet, call describeTable on it.'
      } else {
        colHint = '\n\n⚠️  You haven\'t described any tables yet. Call describeTable on the tables you need.'
        instruction = 'Call describeTable on each table before writing SQL that uses it.'
      }

      return {
        success: false,
        error: `DATABASE QUERY FAILED — DO NOT INVENT OR FABRICATE DATA: ${err.message}${colHint}`,
        instruction
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HITL APPROVAL CHECK — Pause execution if tool requires human approval
  // Uses autonomy level enforcement: SUPERVISED → all marked, GUARDED → high-risk only, AUTONOMOUS → never
  // ═══════════════════════════════════════════════════════════════════════════
  const scopes = await resolveAgentScopes(agent.tenant_id, agent.id)

  // ── HITL Scope Matching ────────────────────────────────────────────────
  // Tool names don't carry connector/MCP UUIDs, so we match by convention:
  //   Built-ins:     exact name        → scopes.approvalBuiltins
  //   MCP tools:     mcp__<sid>__<t>   → extract server ID, check approvalMcpServers
  //   Connectors:    <provider>__<t>   → extract provider prefix, check approvalConnectorProviders
  let hasApprovalScope = scopes.approvalBuiltins.has(toolName)

  if (!hasApprovalScope && toolName.startsWith('mcp__')) {
    // mcp__<serverId_underscored>__<toolName>  →  extract server ID part
    const parts = toolName.split('__')
    if (parts.length >= 3) {
      const serverIdUnderscored = parts[1] // e.g. "abc_123_def"
      hasApprovalScope = scopes.approvalMcpServerIdsUnderscored.has(serverIdUnderscored)
    }
  }

  if (!hasApprovalScope && !toolName.startsWith('mcp__')) {
    // Connector tools are named <provider>__<tool>, e.g. "slack__post_message"
    const doubleUnderscoreIdx = toolName.indexOf('__')
    if (doubleUnderscoreIdx > 0) {
      const providerPrefix = toolName.slice(0, doubleUnderscoreIdx).toLowerCase()
      hasApprovalScope = scopes.approvalConnectorProviders.has(providerPrefix)
    }
  }

  const autonomyLevel = agent.autonomy_level || AUTONOMY_LEVELS.SUPERVISED

  // Check if this tool was already approved in a previous execution cycle
  // (i.e., the task was resumed after approval). If so, skip the approval UI
  // and use the approved/modified input directly.
  const taskContext = agent._taskContext || {}
  const alreadyApproved = taskContext._resumeFromApproval &&
                          taskContext._approvedTool === toolName

  if (alreadyApproved) {
    console.log(`[HITL] Tool ${toolName} was already approved (resume), using approved input`)
    if (taskContext._approvedInput) {
      // Merge approved input but preserve any new fields the agent may have added
      input = { ...taskContext._approvedInput, ...input }
    }
    // Clear the resume flags in the task context so subsequent tool calls
    // still require approval (the approval is for this specific invocation only)
    try {
      const { rows: [currTask] } = await query(
        'SELECT context FROM agent_tasks WHERE id = $1', [agent._currentTaskId]
      )
      if (currTask?.context) {
        const cleanCtx = { ...currTask.context }
        delete cleanCtx._resumeFromApproval
        delete cleanCtx._approvedTool
        delete cleanCtx._approvedInput
        delete cleanCtx._decisionNote
        await query('UPDATE agent_tasks SET context = $1 WHERE id = $2',
          [JSON.stringify(cleanCtx), agent._currentTaskId])
        // Also update the in-memory copy
        agent._taskContext = cleanCtx
      }
    } catch (ctxErr) {
      console.warn(`[HITL] Failed to clear resume context: ${ctxErr.message}`)
    }
    // Continue with tool execution below
  } else {
    const needsApproval = requiresApproval({
      toolName,
      autonomyLevel,
      hasApprovalScope,
    })

    if (needsApproval) {
      const timeoutMinutes = 5

      const { approvalId, deadline } = await createApprovalRequest({
        tenantId: agent.tenant_id,
        agentId: agent.id,
        taskId: agent._currentTaskId,
        toolName,
        toolInput: input,
        autonomyLevel,
        timeoutMinutes,
        executionCheckpoint: {
          toolName,
          toolInput: input,
        },
      })

      broadcastTelemetry(agent.tenant_id, 'agent.approval_required', {
        taskId: agent._currentTaskId,
        approvalId,
        tool: toolName,
        input,
        autonomyLevel,
        deadline: deadline.toISOString(),
        timeoutMinutes,
      })

      // ── Event-Driven Resume ──
      console.log(`[HITL] Tool ${toolName} requires approval for task ${agent._currentTaskId}, pausing execution`)
      return {
        success: false,
        awaiting_approval: true,
        approvalId,
        toolName,
        toolInput: input,
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL EXECUTION — Execute the tool (either approved or doesn't need approval)
  // ═══════════════════════════════════════════════════════════════════════════
  
  if (toolName === 'publish_dashboard_report') {
    try {
      // ── GUARD 1: In-memory dedup — one report per task execution ──
      if (agent._reportPublishedThisTask) {
        console.log('[REPORT TOOL] Rejected duplicate — report already published in this task execution')
        return { success: false, error: 'A report was already published for this task. Do NOT call publish_dashboard_report again.' }
      }

      // ── GUARD 2: Require real data for chart/svg/d3 reports ──
      // Normalize: LLMs sometimes call it "data" instead of "df"
      if (input.data && !input.df) {
        input.df = input.data
        delete input.data
      }

      // Parse df if it's a JSON string (LLMs often stringify arrays)
      if (typeof input.df === 'string') {
        try { input.df = JSON.parse(input.df) } catch { /* leave as-is */ }
      }
      // Parse charts/kpis if they're JSON strings (LLMs often stringify)
      if (typeof input.charts === 'string') {
        try { input.charts = JSON.parse(input.charts) } catch { /* leave as-is */ }
      }
      if (typeof input.kpis === 'string') {
        try { input.kpis = JSON.parse(input.kpis) } catch { /* leave as-is */ }
      }

      const outputFormat = input.output_format || 'chart'
      const hasActualContent = !!input.html_content || !!input.svg_content || !!input.d3_script
      const hasStructuredData = Array.isArray(input.df) && input.df.length > 0
      const hasSections = Array.isArray(input.sections) && input.sections.length > 0

      // ── GUARD 2.5: Auto-replace fabricated df with real query results ──
      // When structured data (df) is provided but the agent has already
      // run a successful query, we silently replace the submitted df with
      // the ACTUAL query rows. Small models frequently hallucinate placeholder
      // data (John/Alice, Product A/B/C) even when real results are in context.
      if (hasStructuredData && agent._ranQuerySuccessfully && agent._lastQueryRows?.length > 0) {
        const submittedKeys = Object.keys(input.df[0] || {}).sort().join(',')
        const realKeys = Object.keys(agent._lastQueryRows[0] || {}).sort().join(',')
        // Only replace if the column structure differs (model fabricated different columns)
        if (submittedKeys !== realKeys) {
          console.log(`[REPORT TOOL] Replacing fabricated df (columns: ${submittedKeys}) with real query results (columns: ${realKeys})`)
          input.df = agent._lastQueryRows
        } else {
          // Same columns — trust the model passed the right data
          console.log('[REPORT TOOL] df columns match last query — using submitted data')
        }
      }

      // ── GUARD 2.6: Block fabricated df when no data-gathering tool
      // has succeeded yet. Works universally for DB, non-DB, and hybrid
      // agents — any real data (runQuery, HTTP, files, connectors) sets
      // _hasRealData, which unlocks df publishing. ──
      if (hasStructuredData && !agent._hasRealData) {
        console.log('[REPORT TOOL] Rejected — df data provided but no data-gathering tool has succeeded (fabricated data)')
        return {
          success: false,
          error: 'Cannot publish report with df data: you have NOT gathered any real data yet. The df you provided appears fabricated. You MUST call a data-gathering tool first (runQuery for databases, http_request for web data, file read for local data, or connector tools for external APIs) to get actual results, then pass the REAL results as df. Never invent placeholder data.'
        }
      }

      if (!hasActualContent && !hasStructuredData && !hasSections && outputFormat !== 'html') {
        console.log('[REPORT TOOL] Rejected — no data. df is empty and no html/svg/d3 content provided')
        const realDataAdvice = agent._dbConnectionString
          ? 'You MUST call runQuery first to get real data, then pass the results as df.'
          : 'You MUST gather real data first (from HTTP, files, APIs, or connectors), then pass the results as df.'
        return {
          success: false,
          error: `Cannot publish report: df is empty and no html_content/svg_content/d3_script was provided. ${realDataAdvice} Do NOT publish an empty report.`
        }
      }

      // ── GUARD 3: DB dedup — don't publish a second report within 30s ──
      const { rows: recent } = await query(
        `SELECT id, title FROM dashboard_reports WHERE tenant_id = $1 AND agent_id = $2 AND created_at > NOW() - INTERVAL '30 seconds' ORDER BY created_at DESC LIMIT 1`,
        [agent.tenant_id, agent.id]
      )
      if (recent.length > 0) {
        console.log('[REPORT TOOL] Skipped duplicate — recent report exists:', recent[0].title)
        return { success: true, message: 'Report already published (deduplicated)', report_id: recent[0].id }
      }

      console.log('[REPORT TOOL] Called with params:', {
        hasTitle: !!input.title,
        outputFormat,
        hasHtmlContent: !!input.html_content,
        hasSvgContent: !!input.svg_content,
        hasD3Script: !!input.d3_script,
        hasDf: !!input.df,
        hasCharts: !!input.charts,
        hasKpis: !!input.kpis,
        hasSections: !!input.sections,
      })
      let title = input.title || agent._taskGoal?.slice(0, 80) || 'Report'
      let htmlContent = input.html_content

      // ── Remove KPI cards and charts for small ranking datasets (≤10 rows).
      // The agent may ignore prompt guidance and pass KPIs anyway — strip them.
      // KPIs like Total/Avg/Max/Min are meaningless for "top N" rankings.
      if (hasStructuredData && input.df.length <= 10) {
        if (input.kpis && !hasActualContent && !hasSections) {
          delete input.kpis
          console.log('[REPORT TOOL] Stripped explicit kpis for small ranking dataset (%d rows)', input.df.length)
        }
        if (input.charts && !hasActualContent && !hasSections && !input.svg_content && !input.d3_script) {
          delete input.charts
          console.log('[REPORT TOOL] Stripped explicit charts for small ranking dataset (%d rows)', input.df.length)
        }
      }

      // ── Route to the right renderer based on output_format ──
      if (outputFormat === 'svg' && input.svg_content) {
        htmlContent = buildSvgReportHtml(input.svg_content, title, input.summary)
      } else if (outputFormat === 'd3' && input.d3_script) {
        htmlContent = buildD3ReportHtml(input.d3_script, input.d3_data, input.d3_title || title, input.summary)
      } else if (outputFormat === 'mixed' && input.sections) {
        htmlContent = buildMixedReportHtml(input.sections, title, input.summary)
      } else if (outputFormat === 'html' && input.html_content) {
        htmlContent = input.html_content
      } else if (!htmlContent && (input.df || input.charts || input.kpis)) {
        // Default: structured data → rich report
        htmlContent = buildRichReportHtml(input, title)
      }

      htmlContent = sanitiseReportHtml(htmlContent)

      if (!htmlContent) {
        return { success: false, error: 'No content provided. Use: output_format: "chart" with df/charts/kpis, "svg" with svg_content, "d3" with d3_script, "html" with html_content, or "mixed" with sections.' }
      }
      const report = await saveReport(agent.tenant_id, agent.id, title, htmlContent)
      agent._reportPublishedThisTask = true  // prevent duplicate publishes in this execution
      return { success: true, message: 'Report published to the dashboard successfully', report_id: report.id }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // ── write_artifact tool ────────────────────────────────────────────────
  if (toolName === 'write_artifact') {
    try {
      const format = input.format || 'json'
      const artifactsDir = join(process.cwd(), '..', '..', 'artifacts', agent.tenant_id, new Date().toISOString().slice(0, 10))
      await mkdir(artifactsDir, { recursive: true })

      const sanitise = (s) => s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
      let downloadUrl = null

      if (format === 'zip' && input.files) {
        // Multi-file folder → zip
        const zipName = sanitise(input.filename || `artifact-${Date.now()}`).replace(/\.zip$/i, '') + '.zip'
        const zipPath = join(artifactsDir, zipName)

        // Dynamic import of archiver for zip creation
        let archiver
        try {
          archiver = (await import('archiver')).default
        } catch {
          // Fallback: create a simple uncompressed archive using tar-like structure
          // or just write as individual files and return a list
          const fileUrls = []
          for (const f of input.files) {
            const filePath = join(artifactsDir, sanitise(f.path.replace(/\.\.\//g, '')))
            await mkdir(dirname(filePath), { recursive: true })
            await writeFile(filePath, f.content || '', 'utf-8')
            fileUrls.push({ path: f.path, file: filePath })
          }
          return {
            success: true,
            message: `${fileUrls.length} files written (zip not available — archiver not installed)`,
            files: fileUrls,
            download_url: null,
            instruction: 'Install archiver: npm install archiver'
          }
        }

        await new Promise((resolve, reject) => {
          const output = createWriteStream(zipPath)
          const archive = archiver('zip', { zlib: { level: 9 } })
          output.on('close', resolve)
          archive.on('error', reject)
          archive.pipe(output)
          for (const f of input.files) {
            archive.append(f.content || '', { name: f.path.replace(/\.\.\//g, '') })
          }
          archive.finalize()
        })
        downloadUrl = `/api/v1/artifacts/${agent.tenant_id}/${zipName}`
      } else {
        // Single file
        const extMap = { svg: '.svg', csv: '.csv', json: '.json', png: '.png', pdf: '.pdf', html: '.html' }
        const ext = extMap[format] || `.${format}`
        const fname = sanitise(input.filename || `output-${Date.now()}`.replace(new RegExp(`\\${ext}$`, 'i'), '')) + ext
        const filePath = join(artifactsDir, fname)

        let content = input.content || ''
        if (format === 'png') {
          content = Buffer.from(content.replace(/^data:image\/png;base64,/, ''), 'base64')
        }
        await writeFile(filePath, content, format === 'png' ? undefined : 'utf-8')
        downloadUrl = `/api/v1/artifacts/${agent.tenant_id}/${fname}`
      }

      return {
        success: true,
        message: 'Artifact saved successfully',
        download_url: downloadUrl,
        format,
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // Configured connector tool (Slack, Jira, GitHub, Gmail, Webhook, …)
  // Dispatched here so the LLM can call e.g. slack__post_message directly.
  // Pass the agent's scoped connector IDs so execution respects tool scoping.
  if (CONNECTOR_TOOL_PREFIXES.some(p => toolName.startsWith(p))) {
    return executeConnectorTool(toolName, input, agent.tenant_id, scopes.allowedConnectors)
  }

  // Build LLM tool definitions for a freshly-created connector so the agent
  // can use it immediately (same naming convention as connector-tools.service.js).
  function buildConnectorToolDefs(conn) {
    switch (conn.tool_id) {
      case 'local-dir': return [{
        name: 'local_dir__list',
        description: `[Local Directory: ${conn.name} — ${conn.config?.path || 'path not set'}] List files and folders. Call WITHOUT any parameter to list the root directory shown above. Returns { path, files: [{ name, type }] }. To list a sub-directory, pass sub_path (e.g. "data" or "reports/2024").`,
        inputSchema: { type: 'object', properties: { sub_path: { type: 'string', description: 'Optional. Sub-directory to list (e.g. "data"). Omit to list the root.' } } }
      }, {
        name: 'local_dir__read',
        description: `[Local Directory: ${conn.name} — ${conn.config?.path || 'path not set'}] Read a file's text contents. MANDATORY: you MUST provide "file_path" — the relative path of the file to read (e.g. "report.csv" or "data/sales.json"). Use local_dir__list FIRST to see what files are available, then pass the exact file name as file_path. Without file_path this will fail.`,
        inputSchema: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string', description: 'REQUIRED — Relative path of the file to read. Get available files from local_dir__list first.' } } }
      }, {
        name: 'local_dir__write',
        description: `[Local Directory: ${conn.name} — ${conn.config?.path || 'path not set'}] Write text content to a file. MANDATORY: you MUST provide "file_path" (relative path, e.g. "output/report.md") AND "content" (the text to write). Creates parent directories if needed. Overwrites existing files.`,
        inputSchema: { type: 'object', required: ['file_path', 'content'], properties: { file_path: { type: 'string', description: 'REQUIRED — Relative path of the file to write to, e.g. "output/report.md"' }, content: { type: 'string', description: 'REQUIRED — The full text content to write to the file' } } }
      }]
      case 'local-shell': return [{
        name: 'local_shell__execute',
        description: `[Local Shell: ${conn.name}] Execute a bash/zsh command on the host. MANDATORY: you MUST provide "command" — the shell command string to execute (e.g. "ls -la" or "cat /etc/hosts").`,
        inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string', description: 'REQUIRED — The shell command to run, e.g. "ls -la"' } } }
      }]
      case 'rest': {
        // REST tools require user-defined operations in config.operations.
        // If the agent didn't specify them, no tools to inject mid-task —
        // the connector will be available on the next task after operations
        // are defined (via the UI or another create_connector call).
        const ops = conn.config?.operations
        if (!Array.isArray(ops) || ops.length === 0) return []
        const slug = String(conn.id).replace(/-/g, '_')
        return ops.map(op => {
          const params = op.params || []
          const requiredParams = params.filter(p => p.required).map(p => p.name)
          const props = params.reduce((acc, p) => {
            acc[p.name] = { type: p.type || 'string', description: p.description || (p.required ? `REQUIRED — ${p.name} parameter` : `Optional ${p.name} parameter`) }
            return acc
          }, {})
          const schema = { type: 'object', properties: props }
          if (requiredParams.length > 0) schema.required = requiredParams
          const reqHint = requiredParams.length > 0 ? ` MANDATORY params: ${requiredParams.join(', ')}.` : ''
          return {
            name: `rest__${slug}__${op.name}`,
            description: `[REST: ${conn.name}] ${op.method} ${op.path} — ${op.description || 'no description'}.${reqHint}`,
            inputSchema: schema
          }
        })
      }
      case 'webhook': return [{
        name: 'webhook__post',
        description: `[Webhook: ${conn.name}] POST a JSON payload to the configured webhook URL. MANDATORY: you MUST provide "payload" — a JSON object with the data to send.`,
        inputSchema: { type: 'object', required: ['payload'], properties: { payload: { type: 'object', description: 'REQUIRED — JSON object to POST to the webhook URL' } } }
      }]
      default: return []
    }
  }

  // create_connector — provision a new connector AND auto-enable for this agent
  if (toolName === 'create_connector') {
    try {
      // Normalise: accept 'type' as alias for 'tool_id', accept top-level
      // path/baseUrl/url and auto-nest into config (LLMs struggle with nesting).
      let { tool_id, name, config = {}, type, path, baseUrl, url } = input
      if (!tool_id) tool_id = type  // alias — LLMs naturally use 'type'
      if (!name) name = input.label || input.title || input.display_name
      // Auto-nest flat params (LLMs pass path/baseUrl/url at top level, not nested in config)
      if (path && !config.path) config = { ...config, path }
      if (baseUrl && !config.baseUrl) config = { ...config, baseUrl }
      if (url && !config.url) config = { ...config, url }
      // Rename config keys the LLM commonly misnames
      if (config.directory && !config.path) config.path = config.directory
      if (config.serverUrl && !config.baseUrl) config.baseUrl = config.serverUrl
      if (config.webhookUrl && !config.url) config.url = config.webhookUrl

      if (!tool_id || !name) {
        return {
          success: false,
          error: `tool_id (connector type) and name are required.\nAccepted types: local-dir, local-shell, rest, webhook.\nExample: { tool_id: "local-dir", name: "My Dir", path: "/tmp/mydir" }`
        }
      }

      const ALLOWED_TYPES = ['local-dir', 'local-shell', 'rest', 'webhook']
      if (!ALLOWED_TYPES.includes(tool_id)) {
        return { success: false, error: `tool_id must be one of: ${ALLOWED_TYPES.join(', ')}` }
      }

      // Validate required config per type
      if (tool_id === 'local-dir' && !config.path) {
        return { success: false, error: 'local-dir requires config.path (absolute path)' }
      }
      if (tool_id === 'rest' && !config.baseUrl) {
        return { success: false, error: 'rest requires config.baseUrl' }
      }
      if (tool_id === 'webhook' && !config.url) {
        return { success: false, error: 'webhook requires config.url' }
      }

      // Check for duplicate (same tool_id + same key config) to avoid littering
      const dedupKey = tool_id === 'local-dir' ? { path: config.path }
        : tool_id === 'rest' ? { baseUrl: config.baseUrl }
        : tool_id === 'webhook' ? { url: config.url }
        : {}
      if (Object.keys(dedupKey).length > 0) {
        const dedupJson = JSON.stringify(dedupKey)
        const { rows: [existing] } = await query(
          `SELECT id FROM tool_connections
           WHERE tenant_id = $1 AND tool_id = $2 AND status = 'ACTIVE'
             AND config @> $3::jsonb
           LIMIT 1`,
          [agent.tenant_id, tool_id, dedupJson]
        )
        if (existing) {
          // Connector exists — just ensure it's scoped to this agent
          await query(
            `INSERT INTO agent_tool_scopes (agent_id, tenant_id, scope_type, connector_id, access_level)
             VALUES ($1, $2, 'connector', $3, 'allowed')
             ON CONFLICT (agent_id, scope_type, connector_id) DO UPDATE SET access_level = 'allowed'`,
            [agent.id, agent.tenant_id, existing.id]
          )
          return {
            success: true,
            created: false,
            alreadyExists: true,
            connectorId: existing.id,
            message: `Connector already exists (${existing.id}). Enabled for this agent.`
          }
        }
      }

      // Create the connector
      const secureConfig = { ...config }
      // If REST has apiKey, store it encrypted in credential_ref style
      if (tool_id === 'rest' && secureConfig.apiKey) {
        secureConfig._apiKey = secureConfig.apiKey
        delete secureConfig.apiKey // never store in plain config
      }

      const { rows: [conn] } = await query(
        `INSERT INTO tool_connections (tenant_id, tool_id, name, status, auth_type, config)
         VALUES ($1, $2, $3, 'ACTIVE', 'API_KEY', $4) RETURNING *`,
        [agent.tenant_id, tool_id, name, JSON.stringify(secureConfig)]
      )

      // Auto-enable for this agent with 'allowed' access
      await query(
        `INSERT INTO agent_tool_scopes (agent_id, tenant_id, scope_type, connector_id, access_level)
         VALUES ($1, $2, 'connector', $3, 'allowed')`,
        [agent.id, agent.tenant_id, conn.id]
      )

      return {
        success: true,
        created: true,
        connectorId: conn.id,
        tool_id: conn.tool_id,
        name: conn.name,
        message: `Connector "${name}" (${tool_id}) created and enabled.`,
        // Return tool definitions so the main loop can inject them mid-task.
        // The agent can use the new connector immediately in its next tool call.
        newTools: buildConnectorToolDefs(conn)
      }
    } catch (err) {
      return { success: false, error: `create_connector failed: ${err.message}` }
    }
  }

  // create_trigger — set up recurring execution for this agent.
  // Creates a single-step AGENT workflow + attaches a SCHEDULE or WEBHOOK trigger.
  if (toolName === 'create_trigger') {
    try {
      const { trigger_type, name, goal, config = {} } = input
      if (!trigger_type || !goal) return { success: false, error: 'trigger_type and goal are required' }
      const triggerName = name || goal.slice(0, 60)

      const VALID_TYPES = ['SCHEDULE', 'WEBHOOK']
      if (!VALID_TYPES.includes(trigger_type)) {
        return { success: false, error: `trigger_type must be one of: ${VALID_TYPES.join(', ')}` }
      }
      if (trigger_type === 'SCHEDULE' && !config.cron) {
        return { success: false, error: 'SCHEDULE trigger requires config.cron (e.g. "0 8 * * *" for daily at 8 AM)' }
      }

      // Validate cron syntax (basic check: 5 fields)
      if (trigger_type === 'SCHEDULE' && config.cron) {
        const parts = config.cron.trim().split(/\s+/)
        if (parts.length !== 5) {
          return { success: false, error: `Invalid cron expression "${config.cron}". Must be 5 fields: minute hour dom month dow. Example: "0 8 * * *"` }
        }
      }

      // Create a single-step workflow that dispatches a task to this agent
      const workflow = await createWorkflow(agent.tenant_id, {
        name: `${agent.name} — ${name}`,
        description: `Auto-created by agent ${agent.name} for recurring task: ${goal.slice(0, 200)}`,
        trigger: trigger_type === 'SCHEDULE'
          ? { type: 'SCHEDULE', cron: config.cron, enabled: true }
          : { type: 'MANUAL' },
        steps: [{
          id: 'agent_task',
          type: 'AGENT',
          input: { agentId: agent.id, goal }
        }],
        onFailure: 'STOP',
        userId: null  // system-created
      })

      // Activate the workflow immediately
      await query(
        `UPDATE workflows SET status = 'ACTIVE' WHERE id = $1 AND tenant_id = $2`,
        [workflow.id, agent.tenant_id]
      )

      // Create the trigger record
      const triggerConfig = trigger_type === 'SCHEDULE'
        ? { cron: config.cron }
        : { ...config, secret: config.secret || createHmac('sha256', process.env.JWT_SECRET || 'kuvalam').update(`${agent.id}:${Date.now()}`).digest('hex').slice(0, 32) }

      const { rows: [trigger] } = await query(
        `INSERT INTO workflow_triggers (tenant_id, workflow_id, trigger_type, name, config, is_active)
         VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING *`,
        [agent.tenant_id, workflow.id, trigger_type, triggerName, JSON.stringify(triggerConfig)]
      )

      let webhookUrl = null
      if (trigger_type === 'WEBHOOK') {
        const baseUrl = process.env.API_BASE_URL || 'http://localhost:3001'
        webhookUrl = `${baseUrl}/api/v1/tenants/${agent.tenant_id}/triggers/webhook/${trigger.id}`
      }

      return {
        success: true,
        trigger_id: trigger.id,
        workflow_id: workflow.id,
        trigger_type,
        name: triggerName,
        cron: trigger_type === 'SCHEDULE' ? config.cron : undefined,
        webhook_url: webhookUrl,
        webhook_secret: trigger_type === 'WEBHOOK' ? triggerConfig.secret : undefined,
        message: trigger_type === 'SCHEDULE'
          ? `Scheduled "${name}" to run ${config.cron}. The scheduler will pick it up within 60 seconds.`
          : `Webhook trigger "${name}" created. POST to ${webhookUrl} with header X-Webhook-Secret: ${triggerConfig.secret} to fire.`
      }
    } catch (err) {
      return { success: false, error: `create_trigger failed: ${err.message}` }
    }
  }

  // create_agent — on-the-fly agent provisioning
  if (toolName === 'create_agent') {
    // ── Scope gate: Allow create_agent when:
    //    a) The task goal explicitly mentions creating/setting up agents (direct intent), OR
    //    b) The agent has ALREADY run at least one tool — proving it tried the work
    //       firsthand and is now legitimately delegating, not hallucinating as a first action.
    const isAgentCreationGoal = /create.*agent|build.*agent|provision.*agent|set.*up.*agent|make.*agent|new agent/i.test(agent._taskGoal)
    const hasRunTools = agent._hasRunAnyTool === true
    if (!isAgentCreationGoal && !hasRunTools) {
      // Dynamically suggest available tools the agent actually has
      const availableDataTools = []
      if (agent._dbConnectionString) availableDataTools.push('listTables', 'describeTable', 'runQuery')
      const availableWebTools = []
      // Build a hints list from the most common tools
      const hints = [
        '🔨 DO THE WORK YOURSELF — you have tools available. Use them.',
        '📊 For data tasks: listTables → describeTable → runQuery',
        '🌐 For web tasks: http_request or browser_use',
        '📁 For files: local_dir__list → local_dir__read',
        '📄 To publish results: publish_dashboard_report',
        '',
        '⛔ create_agent is for LARGE multi-domain tasks only. Your task can be done directly.',
      ].join('\n')

      return {
        success: false,
        error: `⛔ STOP — do NOT call create_agent.\n\n${hints}\n\nYour goal: "${agent._taskGoal?.slice(0, 150)}"\n\nYou have NOT tried any tools yet. Pick ONE tool from the list above and call it NOW. Do not explain, do not reason — just call the tool.`
      }
    }

    // ── Dedup: only allow one agent creation per task.
    if (agent._agentCreatedThisTask) {
      return { success: false, error: `An agent was already created in this task (${agent._createdAgentName || 'unknown'}). Use delegate_task with target_agent_id="${agent._createdAgentId || 'unknown'}" to assign work to it. Do NOT call create_agent again.` }
    }

    try {
      const { name, description, archetype, autonomyLevel, systemPrompt, llmModel } = input
      if (!name) return { success: false, error: 'name is required' }

      const resolvedArchetype = archetype || 'coordinator'

      // ── Derive autonomy level from archetype when not specified ──────────
      // Coordinator/planner/agent-generation agents are autonomous by design;
      // interactive archetypes default to supervised.
      const AUTONOMOUS_ARCHETYPES = new Set(['coordinator', 'planner', 'agent-generation', 'orchestrator'])
      const resolvedAutonomy = autonomyLevel
        || (AUTONOMOUS_ARCHETYPES.has(resolvedArchetype) ? 'AUTONOMOUS' : 'SUPERVISED')

      // ── Generate a rich, role-aware system prompt ────────────────────────
      // Uses the shared generateAgentSystemPrompt helper so created agents
      // get the same quality prompt as builder-UI-created agents.
      const resolvedSystemPrompt = systemPrompt
        || generateAgentSystemPrompt(name, description || `Created by agent ${agent.name}`, resolvedArchetype)

      const newAgent = await createAgent({
        tenantId: agent.tenant_id,
        data: {
          name,
          description: description || `Created by agent ${agent.name}`,
          archetype: resolvedArchetype,
          autonomyLevel: resolvedAutonomy,
          llmProvider: agent.llm_provider,
          llmModel: llmModel || agent.llm_model,
          systemPrompt: resolvedSystemPrompt,
          confidenceThreshold: 0.7,
          maxActionsPerRun: 20
        },
        userId: null  // system-created by agent
      })

      // ── Inherit parent agent's DB connector scopes for data-oriented archetypes ──
      // This ensures analytics/data-analyst agents can immediately query the
      // same databases as the orchestrator that created them.
      const DB_ARCHETYPES = new Set(['data-analyst', 'analytics', 'analyst'])
      if (DB_ARCHETYPES.has(resolvedArchetype)) {
        try {
          const { rows: parentDbScopes } = await query(
            `SELECT ats.connector_id, ats.access_level
             FROM agent_tool_scopes ats
             JOIN tool_connections tc ON ats.connector_id = tc.id
             WHERE ats.agent_id = $1 AND ats.scope_type = 'connector'
               AND tc.tool_id IN ('database', 'postgres')
               AND tc.status = 'ACTIVE'`,
            [agent.id]
          )
          for (const scope of parentDbScopes) {
            await addScope(agent.tenant_id, newAgent.id, {
              scopeType: 'connector',
              connectorId: scope.connector_id,
              accessLevel: scope.access_level,
            }).catch(() => {})  // non-fatal
          }
          if (parentDbScopes.length > 0) {
            console.log(`[create_agent] Inherited ${parentDbScopes.length} DB scope(s) from parent agent ${agent.id} to new agent ${newAgent.id}`)
          }
        } catch (err) {
          console.warn(`[create_agent] Failed to inherit parent DB scopes: ${err.message}`)
        }
      }

      // Track for dedup (prevents multiple agent creations in one task)
      agent._agentCreatedThisTask = true
      agent._createdAgentId = newAgent.id
      agent._createdAgentName = newAgent.name

      return {
        success: true,
        created: true,
        agent_id: newAgent.id,
        name: newAgent.name,
        archetype: newAgent.archetype,
        autonomy_level: resolvedAutonomy,
        message: `Agent "${newAgent.name}" (${newAgent.archetype}, ${resolvedAutonomy}) created with a rich system prompt and archetype-specific tool scopes. Use delegate_task with target_agent_id="${newAgent.id}" to assign work to it immediately.`
      }
    } catch (err) {
      return { success: false, error: `create_agent failed: ${err.message}` }
    }
  }

  // create_workflow — build a multi-step integration pipeline
  if (toolName === 'create_workflow') {
    try {
      const { name, description, steps, activate } = input
      if (!name) return { success: false, error: 'name is required' }
      if (!steps || !Array.isArray(steps) || steps.length === 0) {
        return { success: false, error: 'steps must be a non-empty array of step objects' }
      }

      // Validate each step has id + type
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]
        if (!s.id) return { success: false, error: `steps[${i}] missing required field: id` }
        if (!s.type) return { success: false, error: `steps[${i}] missing required field: type` }
        const VALID_TYPES = ['AGENT', 'TOOL', 'HTTP', 'NOTIFY', 'CONDITION', 'APPROVAL', 'TRANSFORM', 'DELAY', 'PARALLEL', 'LOOP', 'CREW', 'DB', 'WAIT', 'SET', 'SCRIPT']
        if (!VALID_TYPES.includes(s.type)) {
          return { success: false, error: `steps[${i}] has invalid type "${s.type}". Valid: ${VALID_TYPES.join(', ')}` }
        }
      }

      const workflow = await createWorkflow(agent.tenant_id, {
        name,
        description: description || `Created by agent ${agent.name}`,
        trigger: { type: 'MANUAL' },
        steps,
        onFailure: 'STOP',
        userId: null  // system-created
      })

      // Optionally activate immediately
      if (activate) {
        await query(
          `UPDATE workflows SET status = 'ACTIVE' WHERE id = $1 AND tenant_id = $2`,
          [workflow.id, agent.tenant_id]
        )
      }

      return {
        success: true,
        workflow_id: workflow.id,
        name: workflow.name,
        status: activate ? 'ACTIVE' : 'DRAFT',
        stepCount: steps.length,
        message: activate
          ? `Workflow "${name}" created and activated with ${steps.length} steps.`
          : `Workflow "${name}" created as DRAFT with ${steps.length} steps. Set activate=true to activate, or attach a trigger with create_trigger.`
      }
    } catch (err) {
      return { success: false, error: `create_workflow failed: ${err.message}` }
    }
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

      // Poll for completion with exponential backoff (1s → 2s → 4s → max 8s)
      const deadline = Date.now() + DELEGATION_TIMEOUT_MS
      let pollInterval = 1000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollInterval))
        pollInterval = Math.min(pollInterval * 2, 8000)
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
          return { success: false, error: pollData.status?.message || 'Remote agent task failed' }
        }
      }
      return { success: false, error: `A2A task timed out after ${DELEGATION_TIMEOUT_MS / 60000} minutes` }
    } catch (err) {
      return { success: false, error: `A2A error: ${err.message}` }
    }
  }

  // --- Phase 3: CrewAI-style Internal Delegation ---
  if (toolName === 'delegate_task') {
    try {
      const { target_agent_id, goal: delegateGoal } = input
      if (!target_agent_id || !delegateGoal) return { success: false, error: 'target_agent_id and goal are required' }

      // Validate the target agent belongs to the same tenant and is active
      const { rows: [targetAgent] } = await query(
        `SELECT id FROM agents WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'`,
        [target_agent_id, agent.tenant_id]
      )
      if (!targetAgent) return { success: false, error: 'Invalid or inactive target agent ID' }

      // Dispatch the sub-task
      const subtask = await dispatchTask({
        tenantId: agent.tenant_id,
        agentId: target_agent_id,
        goal: delegateGoal,
        priority: 'HIGH',
        context: { parentTaskId: agent._currentTaskId }
      })

      // Poll for completion with exponential backoff (1s → 2s → 4s → max 8s)
      const deadline = Date.now() + DELEGATION_TIMEOUT_MS
      let pollInterval = 1000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollInterval))
        pollInterval = Math.min(pollInterval * 2, 8000)
        const { rows: [pollData] } = await query(
          `SELECT status, result, error FROM agent_tasks WHERE id = $1`,
          [subtask.taskId]
        )
        if (pollData?.status === 'COMPLETED') {
          // Return the FULL result — delegating agent needs ALL output (reports,
          // tables, analysis), not just a one-line summary. Include summary as a
          // convenience field when the delegate published one.
          const fullResult = pollData.result || {}
          const summary = fullResult.summary || (typeof fullResult === 'string' ? fullResult.slice(0, 500) : null)
          return { success: true, result: fullResult, summary }
        }
        if (pollData?.status === 'FAILED') {
          return { success: false, error: pollData.error || 'Sub-task failed' }
        }
      }
      return { success: false, error: `Delegated task timed out after ${DELEGATION_TIMEOUT_MS / 60000} minutes` }
    } catch (err) {
      return { success: false, error: `Delegation error: ${err.message}` }
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
      if (!input.url || typeof input.url !== 'string') {
        return { success: false, error: 'url is required' }
      }
      // SSRF guard — only allow http(s) and block private/loopback in production
      const parsedUrl = (() => { try { return new URL(input.url) } catch { return null } })()
      if (!parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol)) {
        return { success: false, error: 'url must be a valid http(s) URL' }
      }
      if (process.env.NODE_ENV === 'production') {
        const host = parsedUrl.hostname
        if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|fc00:|fe80:)/i.test(host) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
          return { success: false, error: 'url must not target private/internal addresses' }
        }
      }
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

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 9 WEAPONS — New built-in tool execution handlers
  // ═══════════════════════════════════════════════════════════════════════════

  // http_download — fetch a file from a URL
  if (toolName === 'http_download') {
    try {
      if (!input.url) return { success: false, error: 'url is required' }
      
      // SSRF protection
      try {
        assertSafeUrl(input.url)
      } catch (err) {
        return { success: false, error: `Unsafe URL: ${err.message}` }
      }
      
      const response = await fetch(input.url)
      if (!response.ok) return { success: false, error: `HTTP ${response.status}: ${response.statusText}` }
      const contentLength = response.headers.get('content-length')
      if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) {
        return { success: false, error: 'File too large (max 5MB)' }
      }
      if (input.encoding === 'base64') {
        const buf = Buffer.from(await response.arrayBuffer())
        return { success: true, data: buf.toString('base64'), encoding: 'base64', size: buf.length }
      }
      if (input.encoding === 'json') {
        return { success: true, data: await response.json() }
      }
      const text = await response.text()
      return { success: true, data: text.slice(0, 500_000), truncated: text.length > 500_000, size: text.length }
    } catch (err) {
      return { success: false, error: `Download failed: ${err.message}` }
    }
  }

  // file_search — search files using Node.js fs APIs (no shell injection)
  if (toolName === 'file_search') {
    try {
      const pattern = input.pattern
      const searchPath = input.path || process.cwd()
      const filePattern = input.filePattern || '*'
      const maxResults = Math.min(input.maxResults || 20, 100)
      const caseSensitive = input.caseSensitive || false

      // Validate inputs
      if (!pattern || typeof pattern !== 'string') {
        return { success: false, error: 'pattern is required and must be a string' }
      }

      // Use safe Node.js-based file search (no shell commands)
      const matches = await searchFiles(pattern, searchPath, {
        filePattern,
        maxResults,
        caseSensitive,
        maxDepth: 10
      })

      return { 
        success: true, 
        matches: matches.map(m => `${m.file}:${m.line}: ${m.content}`),
        count: matches.length,
        engine: 'node-fs'
      }
    } catch (err) {
      return { success: false, error: `File search failed: ${err.message}` }
    }
  }

  // docker_run — execute a command in a Docker container (using safe spawn)
  if (toolName === 'docker_run') {
    try {
      const image = input.image
      const command = input.command
      const timeout = Math.min(input.timeout || 30, 120)

      // Validate image name
      if (!isValidDockerImage(image)) {
        return { success: false, error: 'Invalid or disallowed Docker image name' }
      }

      // Build args array (no shell interpolation)
      const args = ['run', '--rm', '--network', 'none']
      
      if (input.workdir) {
        args.push('-w', input.workdir)
      }
      
      if (input.mount) {
        // Validate mount format: /host/path:/container/path
        if (!/^\/[^:]+\:[^:]+$/.test(input.mount)) {
          return { success: false, error: 'Invalid mount format. Use /host/path:/container/path' }
        }
        args.push('-v', input.mount)
      }
      
      if (input.env && typeof input.env === 'object') {
        for (const [key, value] of Object.entries(input.env)) {
          args.push('-e', `${key}=${value}`)
        }
      }
      
      args.push(image, 'sh', '-c', command)

      // Execute with safe spawn (no shell)
      const result = await safeSpawn('docker', args, { timeout: timeout * 1000 })
      
      if (result.code !== 0) {
        return { success: false, error: `Docker exited with code ${result.code}: ${result.stderr}` }
      }
      
      return { success: true, output: result.stdout, image, command }
    } catch (err) {
      return { success: false, error: `Docker execution failed: ${err.message}` }
    }
  }

  // ssh_exec — execute a command on a remote machine (using safe spawn)
  if (toolName === 'ssh_exec') {
    try {
      const host = input.host
      const command = input.command
      const port = input.port || 22
      const user = input.user || 'root'
      const timeout = Math.min(input.timeout || 30, 120)

      // Validate host
      if (!isValidHost(host)) {
        return { success: false, error: 'Invalid or disallowed host' }
      }

      // Validate port
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { success: false, error: 'Invalid port number' }
      }

      // Validate user (alphanumeric, underscore, hyphen only)
      if (!/^[a-zA-Z0-9_\-]+$/.test(user)) {
        return { success: false, error: 'Invalid username' }
      }

      // Build args array (no shell interpolation)
      const args = [
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=10',
        '-p', String(port),
        `${user}@${host}`,
        command
      ]

      // Execute with safe spawn (no shell)
      const result = await safeSpawn('ssh', args, { timeout: timeout * 1000 })
      
      if (result.code !== 0) {
        return { success: false, error: `SSH exited with code ${result.code}: ${result.stderr}` }
      }
      
      return { success: true, output: result.stdout, host }
    } catch (err) {
      return { success: false, error: `SSH execution failed: ${err.message}` }
    }
  }

  // Find matching skill
  const skill = skills.find(s => s.name.replace(/\s+/g, '_').toLowerCase() === toolName)
  if (!skill) return { success: false, error: `Tool "${toolName}" not found. Available DB tools: listTables, describeTable, runQuery. Available connector tools depend on your connectors. Check your spelling — use camelCase (e.g. "listTables", NOT "list_tables").` }

  // Execute custom code skill (Kuvalam NextGen) — JavaScript
  if (skill.config?.code && skill.config?.language !== 'python') {
    try {
      // Execute the JS snippet in the sandbox
      // Pass any decrypted environment secrets configured for this script
      const envVars = decryptCredentials(skill.config?.env || {})
      const result = await executeCustomSkill(skill.config.code, input, envVars)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // Execute Python skill
  if (skill.config?.language === 'python' && skill.config?.code) {
    try {
      const envVars = decryptCredentials(skill.config?.env || {})
      const result = await executePythonSkill(skill.config.code, input, envVars)
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // Execute Natural Language skill (Business Playbooks)
  if (skill.config?.instruction) {
    // ── Playbook dedup: if this playbook was already called in this task,
    // block re-invocation. The LLM sometimes calls the same playbook with
    // different fabricated inputs, which spawns duplicate sub-tasks.
    if (agent._calledPlaybooks?.has(skill.name)) {
      console.warn(`[Playbook] BLOCKED duplicate invocation of "${skill.name}" — already called in this task`)
      return { success: false, error: `Playbook "${skill.name}" was already executed in this task. Use existing results instead of calling it again.` }
    }
    agent._calledPlaybooks?.add(skill.name)

    try {
      // We spawn a specialized sub-task to handle this plain-english request.
      const subGoal = `PLAYBOOK INSTRUCTION:\n${skill.config.instruction}\n\nINPUT DATA:\n${JSON.stringify(input, null, 2)}`
      
      // Enqueue the sub-task on the SAME agent.
      const { rows: [subTask] } = await query(
        `INSERT INTO agent_tasks (agent_id, tenant_id, goal, context, priority, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'QUEUED',$6) RETURNING *`,
        [agent.id, agent.tenant_id, subGoal, { parentTaskId: agent._currentTaskId }, 5, null]
      )
      
      const { enqueueTask } = await import('./queue.service.js')
      await enqueueTask(subTask, agent, async (t, a) => {
        // dynamic import to avoid circular dependency
        const { executeTask } = await import('./task.service.js')
        return executeTask(t, a)
      })

      // Wait up to 5 minutes for the sub-agent to finish
      const deadline = Date.now() + 5 * 60 * 1000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000))
        const { rows } = await query(`SELECT status, result, error FROM agent_tasks WHERE id = $1`, [subTask.id])
        if (rows[0]?.status === 'COMPLETED') {
          const result = rows[0].result
          // ⚠️  Sub-task synthesis may be hallucinated — the playbook's own
          // execution loop may have failed to gather data and fabricated output.
          // Check hallucinationScore and synthesis-failure markers.
          if (result && typeof result === 'object') {
            const hs = result.hallucinationScore ?? result.hallucination_score ?? 0
            if (hs >= 50) {
              return { success: false, error: `Playbook "${skill.name}" produced hallucinated output (score: ${hs}). Data must come from real tools (runQuery, http_request), not fabricated. The playbook sub-task failed to gather real data.` }
            }
            // Also reject if the sub-task synthesis is just a failure message
            const output = result.output || result.summary || ''
            if (typeof output === 'string' && /⚠️.*Task could not be completed|All data-gathering attempts failed/i.test(output)) {
              return { success: false, error: `Playbook "${skill.name}" failed to gather real data. Sub-task reported: ${output.slice(0, 200)}` }
            }
          }
          return { success: true, data: result }
        }
        if (rows[0]?.status === 'FAILED') return { success: false, error: rows[0].error }
      }
      return { success: false, error: 'Natural language skill timed out' }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // Execute based on skill config (Legacy HTTP webhook)
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

  // ── Knowledge Graph search tool (runtime, on-demand) ────────────────────
  // Unlike the pre-task graph injection in retrieveKnowledge(), this lets the
  // agent call searchGraph mid-task to explore entity relationships as it
  // discovers new concepts during execution.
  if (toolName === 'searchGraph') {
    if (!input.query || typeof input.query !== 'string') {
      return { success: false, error: 'query is required. Example: { "query": "Acme Corp" }' }
    }
    try {
      const { getAgentGraphConnectors, searchKnowledgeGraph } = await import('./graph-knowledge.service.js')
      const graphConns = await getAgentGraphConnectors(agent.id, agent.tenant_id)
      if (graphConns.length === 0) {
        return { success: false, error: 'No knowledge graph connectors are scoped to this agent.' }
      }
      const results = []
      for (const conn of graphConns) {
        try {
          const blocks = await searchKnowledgeGraph(conn, input.query)
          // Extract entities from the blocks for a structured response
          for (const block of blocks) {
            const content = block.content || ''
            // Parse entity lines: "• EntityName [Type]"
            const entityMatches = content.match(/•\s+(\S+)\s+\[([^\]]+)\]/g)
            if (entityMatches) {
              for (const em of entityMatches) {
                const m = em.match(/•\s+(\S+)\s+\[([^\]]+)\]/)
                if (m) results.push({ entity: m[1], type: m[2] })
              }
            }
            // Parse relationship lines: "  → REL → Target (Type)"
            const relMatches = content.match(/→\s+(\S+)\s+→\s+(\S+)\s+\(([^)]+)\)/g)
            if (relMatches) {
              for (const rm of relMatches) {
                const m = rm.match(/→\s+(\S+)\s+→\s+(\S+)\s+\(([^)]+)\)/)
                if (m) results.push({ relationship: m[1], from: results[results.length - 1]?.entity || '?', to: m[2], toType: m[3] })
              }
            }
          }
        } catch { /* individual connector failure — try next */ }
      }
      return {
        success: true,
        query: input.query,
        results: results.length > 0 ? results : [],
        count: results.length,
        hint: results.length === 0 ? 'No matching entities found. Try a different keyword or check if the graph has been populated.' : undefined,
      }
    } catch (err) {
      return { success: false, error: `Graph search failed: ${err.message}` }
    }
  }

  return { success: false, error: 'Skill not yet implemented' }
}

export async function cancelTask(tenantId, agentId, taskId, userId) {
  const { rowCount } = await query(
    `UPDATE agent_tasks 
     SET status = 'CANCELLED', completed_at = NOW() 
     WHERE id = $1 AND agent_id = $2 AND tenant_id = $3 AND status IN ('PENDING', 'RUNNING')`,
    [taskId, agentId, tenantId]
  )
  if (rowCount === 0) throw new AppError('NOT_FOUND', 'Active task not found or already completed', 404)
  await auditLog({
    eventType: 'agent.task_cancelled', tenantId, actorId: userId, actorType: 'USER',
    resourceType: 'AgentTask', resourceId: taskId, action: 'CANCEL',
    metadata: { agentId }
  })
  return { success: true }
}
