// apps/api/src/services/agent.service.js
import { query, transaction } from '../db/pool.js'
import { auditLog } from '../utils/audit.js'
import { AppError } from '../utils/errors.js'
import { checkPlanLimit } from './plan-limits.service.js'
import { getArchetypeScopePresets } from './agent-scope.service.js'

/**
 * Strip characters that could be used for LLM prompt injection from
 * user-controlled strings that get interpolated into system prompts.
 */
function sanitizePromptText(str) {
  if (typeof str !== 'string') return ''
  // Remove markdown code fences, XML tags, and system-prompt-like directives
  return str
    .replace(/```[\s\S]*?```/g, '[code block removed]')
    .replace(/<\/?\s*(system|instruction|prompt|role)\s*>/gi, '')
    .replace(/<(\|)?\s*endofprompt\s*(\|)?>/gi, '')
    .replace(/ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/gi, '[redacted]')
    .slice(0, 4000) // cap length
}

export async function createAgent({ tenantId, data, userId }) {
  // Sanitize user-controlled fields that may end up in LLM prompts
  const safeName = sanitizePromptText(data.name)
  const safeDescription = sanitizePromptText(data.description)
  const safeSystemPrompt = sanitizePromptText(data.systemPrompt)

  // Plan limit check
  const { rows: [countRow] } = await query(
    `SELECT COUNT(*) as count FROM agents
     WHERE tenant_id = $1 AND status != 'ARCHIVED'`,
    [tenantId]
  )
  await checkPlanLimit(tenantId, 'agents', parseInt(countRow?.count || 0))

  const { rows: [agent] } = await query(
    `INSERT INTO agents (tenant_id, name, description, archetype, autonomy_level, llm_provider, llm_model, system_prompt, confidence_threshold, max_actions_per_run, report_dir, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [tenantId, safeName, safeDescription, data.archetype, data.autonomyLevel || 'SUPERVISED',
     data.llmProvider || 'openai', data.llmModel || 'gpt-4o', safeSystemPrompt,
     data.confidenceThreshold || 0.75, data.maxActionsPerRun || 20, data.reportDir || null, userId]
  )

  await auditLog({ eventType: 'agent.created', tenantId, actorId: userId, actorType: 'USER', resourceType: 'Agent', resourceId: agent.id, action: 'CREATE', afterState: { name: safeName } })

  // ── Auto-link Knowledge Bases & Knowledge Graphs ─────────────────────
  // When an agent is created, automatically link all active KBs and KGs
  // from the same tenant. This avoids the manual step of navigating to
  // agent settings → linking each KB/KG individually. The agent gets the
  // full knowledge context (vector + graph) right from creation.
  try {
    const { rows: kbs } = await query(
      `SELECT id FROM knowledge_bases
       WHERE tenant_id = $1 AND status = 'ACTIVE'
       ORDER BY created_at DESC`,
      [tenantId]
    )
    for (const kb of kbs) {
      await query(
        `INSERT INTO agent_knowledge_bases (agent_id, knowledge_base_id, tenant_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (agent_id, knowledge_base_id) DO NOTHING`,
        [agent.id, kb.id, tenantId]
      )
    }
    if (kbs.length > 0) console.log(`[agent] Auto-linked ${kbs.length} knowledge base(s) to agent ${agent.id}`)
  } catch (err) {
    console.warn(`[agent] Failed to auto-link knowledge bases: ${err.message}`)
  }

  try {
    const { rows: kgs } = await query(
      `SELECT id FROM knowledge_graphs
       WHERE tenant_id = $1 AND status = 'ACTIVE'
       ORDER BY created_at DESC`,
      [tenantId]
    )
    for (const kg of kgs) {
      await query(
        `INSERT INTO agent_knowledge_graphs (agent_id, knowledge_graph_id, tenant_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (agent_id, knowledge_graph_id) DO NOTHING`,
        [agent.id, kg.id, tenantId]
      )
    }
    if (kgs.length > 0) console.log(`[agent] Auto-linked ${kgs.length} knowledge graph(s) to agent ${agent.id}`)
  } catch (err) {
    console.warn(`[agent] Failed to auto-link knowledge graphs: ${err.message}`)
  }

  // ── Auto-apply archetype tool scopes ─────────────────────────────────
  // Each archetype has curated presets that define which connectors, MCPs,
  // and built-in tools the agent should have access to. This enforces
  // least-privilege by default instead of granting all tools.
  const archetype = data.archetype
  if (archetype) {
    const presets = getArchetypeScopePresets(archetype)
    if (presets && presets.length > 0) {
      try {
        // Resolve connectorType presets (e.g. "slack") to actual connector IDs
        const { rows: connectors } = await query(
          `SELECT id, tool_id FROM tool_connections
           WHERE tenant_id = $1 AND status = 'ACTIVE' AND tool_id = ANY($2)`,
          [tenantId, presets.filter(p => p.scopeType === 'connectorType').map(p => p.connectorType)]
        )
        const connectorMap = {}
        for (const c of connectors) connectorMap[c.tool_id.toLowerCase()] = c.id

        for (const preset of presets) {
          if (preset.scopeType === 'connectorType') {
            const connId = connectorMap[preset.connectorType?.toLowerCase()]
            if (connId) {
              await query(
                `INSERT INTO agent_tool_scopes (agent_id, tenant_id, scope_type, connector_id, access_level)
                 VALUES ($1,$2,'connector',$3,$4)
                 ON CONFLICT (agent_id, scope_type, connector_id) DO NOTHING`,
                [agent.id, tenantId, connId, preset.accessLevel]
              )
            }
          } else if (preset.scopeType === 'builtin') {
            await query(
              `INSERT INTO agent_tool_scopes (agent_id, tenant_id, scope_type, builtin_name, access_level)
               VALUES ($1,$2,'builtin',$3,$4)
               ON CONFLICT (agent_id, scope_type, builtin_name) DO NOTHING`,
              [agent.id, tenantId, preset.builtinName, preset.accessLevel]
            )
          } else if (preset.scopeType === 'group') {
            await query(
              `INSERT INTO agent_tool_scopes (agent_id, tenant_id, scope_type, group_name, access_level)
               VALUES ($1,$2,'group',$3,$4)
               ON CONFLICT (agent_id, scope_type, group_name) DO NOTHING`,
              [agent.id, tenantId, preset.groupName, preset.accessLevel]
            )
          }
        }
        console.log(`[agent] Applied ${presets.length} archetype scope presets for '${archetype}' on agent ${agent.id}`)
      } catch (err) {
        // Non-fatal: agent is created even if scope presets fail
        console.warn(`[agent] Failed to apply archetype scope presets: ${err.message}`)
      }
    }
  }

  return agent
}

export async function getAgent(tenantId, agentId) {
  const { rows: [agent] } = await query(
    `SELECT a.*,
      (SELECT json_agg(row_to_json(s)) FROM agent_skills s WHERE s.agent_id = a.id AND s.is_enabled = true) as skills,
      (SELECT json_agg(row_to_json(r) ORDER BY r.priority) FROM agent_rules r WHERE r.agent_id = a.id AND r.is_active = true) as rules,
      (SELECT json_agg(kb.id) FROM agent_knowledge_bases akb JOIN knowledge_bases kb ON kb.id = akb.knowledge_base_id WHERE akb.agent_id = a.id) as knowledge_base_ids,
      (SELECT json_agg(kg.id) FROM agent_knowledge_graphs akg JOIN knowledge_graphs kg ON kg.id = akg.knowledge_graph_id WHERE akg.agent_id = a.id) as knowledge_graph_ids
     FROM agents a
     WHERE a.id = $1 AND a.tenant_id = $2`,
    [agentId, tenantId]
  )
  if (!agent) throw new AppError('AGENT_NOT_FOUND', 'Agent not found', 404)
  return agent
}

export async function listAgents(tenantId, { status, page = 1, pageSize = 20 } = {}) {
  const conditions = ['tenant_id = $1']
  const params = [tenantId]

  // Default: exclude ARCHIVED. Only include archived agents when explicitly requested.
  if (status) {
    conditions.push(`status = $${params.length + 1}`); params.push(status)
  } else {
    conditions.push(`status != 'ARCHIVED'`)
  }

  const offset = (page - 1) * pageSize
  const { rows } = await query(
    `SELECT * FROM agents WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  )
  const { rows: [{ count }] } = await query(`SELECT COUNT(*) FROM agents WHERE ${conditions.join(' AND ')}`, params)

  return { agents: rows, pagination: { page, pageSize, total: parseInt(count), totalPages: Math.ceil(parseInt(count) / pageSize) } }
}

export async function updateAgent(tenantId, agentId, updates, userId) {
  // Fetch current state BEFORE update for audit trail
  const { rows: [before] } = await query(
    'SELECT name, llm_model, llm_provider, status FROM agents WHERE id = $1 AND tenant_id = $2',
    [agentId, tenantId]
  )
  if (!before) throw new AppError('AGENT_NOT_FOUND', 'Agent not found', 404)

  const allowed = ['name','description','system_prompt','autonomy_level','llm_provider','llm_model','confidence_threshold','max_actions_per_run','report_dir']
  const fields = Object.keys(updates).filter(k => allowed.includes(k) || allowed.includes(toSnakeCase(k)))
  if (fields.length === 0) throw new AppError('NO_VALID_FIELDS', 'No valid fields to update', 400)

  // Map camelCase to snake_case, sanitizing prompt-injectable fields
  const mapped = {}
  for (const k of fields) {
    const sk = toSnakeCase(k)
    mapped[sk] = (sk === 'name' || sk === 'description' || sk === 'system_prompt')
      ? sanitizePromptText(updates[k])
      : updates[k]
  }

  const setClause = Object.keys(mapped).map((f, i) => `${f} = $${i + 3}`).join(', ')
  const { rows: [agent] } = await query(
    `UPDATE agents SET ${setClause} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [agentId, tenantId, ...Object.values(mapped)]
  )
  if (!agent) throw new AppError('AGENT_NOT_FOUND', 'Agent not found', 404)

  await auditLog({
    eventType: 'agent.updated', tenantId, actorId: userId, actorType: 'USER',
    resourceType: 'Agent', resourceId: agentId, action: 'UPDATE',
    beforeState: { name: before.name, model: before.llm_model, provider: before.llm_provider, status: before.status },
    afterState: { name: agent.name, model: agent.llm_model, provider: agent.llm_provider, status: agent.status }
  })
  return agent
}

export async function activateAgent(tenantId, agentId, userId) {
  const { rows: [agent] } = await query(
    'SELECT * FROM agents WHERE id = $1 AND tenant_id = $2',
    [agentId, tenantId]
  )
  if (!agent) throw new AppError('AGENT_NOT_FOUND', 'Agent not found', 404)
  if (agent.status === 'ACTIVE') return agent

  const { rows: [skills] } = await query(
    'SELECT COUNT(*) as count FROM agent_skills WHERE agent_id = $1 AND is_enabled = true',
    [agentId]
  )
  // Agent can activate without skills in SUPERVISED mode

  const { rows: [updated] } = await query(
    `UPDATE agents SET status = 'ACTIVE' WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [agentId, tenantId]
  )

  await auditLog({ eventType: 'agent.activated', tenantId, actorId: userId, actorType: 'USER', resourceType: 'Agent', resourceId: agentId, action: 'ACTIVATE' })
  return updated
}

export async function addSkill(tenantId, agentId, skillData, userId) {
  const { rows: [skill] } = await query(
    `INSERT INTO agent_skills (agent_id, tenant_id, tool_connection_id, action_id, name, description, requires_approval, config)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [agentId, tenantId, skillData.toolConnectionId || null, skillData.actionId || 'http_request',
     skillData.name, skillData.description, skillData.requiresApproval || false, skillData.config || {}]
  )
  await auditLog({ eventType: 'agent.skill_added', tenantId, actorId: userId, actorType: 'USER', resourceType: 'AgentSkill', resourceId: skill.id, action: 'ADD_SKILL' })
  return skill
}

export async function addRule(tenantId, agentId, ruleData, userId) {
  const { rows: [rule] } = await query(
    `INSERT INTO agent_rules (agent_id, tenant_id, rule_type, name, condition, enforcement, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [agentId, tenantId, ruleData.ruleType || 'GUARDRAIL', ruleData.name,
     ruleData.condition || {}, ruleData.enforcement || 'BLOCK', ruleData.priority || 100]
  )
  await auditLog({ eventType: 'agent.rule_added', tenantId, actorId: userId, actorType: 'USER', resourceType: 'AgentRule', resourceId: rule.id, action: 'ADD_RULE' })
  return rule
}

export async function linkKnowledgeBase(tenantId, agentId, knowledgeBaseId, userId) {
  await query(
    'INSERT INTO agent_knowledge_bases (agent_id, knowledge_base_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [agentId, knowledgeBaseId]
  )
  await auditLog({ eventType: 'agent.knowledge_base_linked', tenantId, actorId: userId, actorType: 'USER', resourceType: 'Agent', resourceId: agentId, action: 'LINK_KB' })
}

function toSnakeCase(str) {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

export async function deleteAgent(tenantId, agentId, userId) {
  // ── L2 Soft Delete: archive instead of hard DELETE ────────────────────────
  // Hard deleting agents immediately would:
  //   a) lose all historical task/audit data linked to this agent,
  //   b) break in-flight tasks that reference the agentId,
  //   c) prevent accidental-delete recovery.
  // ARCHIVED agents do not appear in normal listings (excluded by status filter)
  // and cannot be dispatched to. A separate /purge endpoint (admin only) does
  // the hard DELETE after a retention window.
  const { rowCount } = await query(
    `UPDATE agents
     SET status = 'ARCHIVED', deleted_at = NOW(), deleted_by = $3
     WHERE id = $1 AND tenant_id = $2 AND status != 'ARCHIVED'`,
    [agentId, tenantId, userId]
  )
  if (rowCount === 0) throw new AppError('NOT_FOUND', 'Agent not found or already archived', 404)
  await auditLog({
    eventType: 'agent.archived', tenantId, actorId: userId, actorType: 'USER',
    resourceType: 'Agent', resourceId: agentId, action: 'ARCHIVE'
  })
}

export async function removeSkill(tenantId, agentId, skillId, userId) {
  // Join with agents table to derive tenant isolation from the agent, not the
  // skill — this handles the case where a skill was created with an incorrect
  // tenant_id (e.g. before the RLS transaction fix).
  const { rowCount } = await query(
    `DELETE FROM agent_skills s USING agents a
     WHERE s.id = $1 AND s.agent_id = $2 AND a.id = s.agent_id AND a.tenant_id = $3`,
    [skillId, agentId, tenantId]
  )
  if (rowCount === 0) throw new AppError('NOT_FOUND', 'Skill not found', 404)
  await auditLog({ eventType: 'agent.skill_removed', tenantId, actorId: userId, actorType: 'USER', resourceType: 'Agent', resourceId: agentId, action: 'REMOVE_SKILL', afterState: { skillId } })
}

export async function removeRule(tenantId, agentId, ruleId, userId) {
  const { rowCount } = await query(
    `DELETE FROM agent_rules r USING agents a
     WHERE r.id = $1 AND r.agent_id = $2 AND a.id = r.agent_id AND a.tenant_id = $3`,
    [ruleId, agentId, tenantId]
  )
  if (rowCount === 0) throw new AppError('NOT_FOUND', 'Rule not found', 404)
  await auditLog({ eventType: 'agent.rule_removed', tenantId, actorId: userId, actorType: 'USER', resourceType: 'Agent', resourceId: agentId, action: 'REMOVE_RULE', afterState: { ruleId } })
}

export async function unlinkKnowledgeBase(tenantId, agentId, kbId, userId) {
  const { rowCount } = await query(
    `DELETE FROM agent_knowledge_bases kb USING agents a
     WHERE kb.knowledge_base_id = $1 AND kb.agent_id = $2 AND a.id = kb.agent_id AND a.tenant_id = $3`,
    [kbId, agentId, tenantId]
  )
  if (rowCount === 0) throw new AppError('NOT_FOUND', 'Knowledge base link not found', 404)
  await auditLog({ eventType: 'agent.kb_unlinked', tenantId, actorId: userId, actorType: 'USER', resourceType: 'Agent', resourceId: agentId, action: 'UNLINK_KB', afterState: { kbId } })
}

export async function deleteTask(tenantId, agentId, taskId, userId) {
  // Clean up related data first to avoid FK violations
  await query('DELETE FROM agent_episodic_memory WHERE task_id = $1', [taskId])
  await query('UPDATE approval_requests SET task_id = NULL WHERE task_id = $1', [taskId])
  const { rowCount } = await query(
    `DELETE FROM agent_tasks t USING agents a
     WHERE t.id = $1 AND t.agent_id = $2 AND a.id = t.agent_id AND a.tenant_id = $3`,
    [taskId, agentId, tenantId]
  )
  if (rowCount === 0) throw new AppError('NOT_FOUND', 'Task not found', 404)
  await auditLog({ eventType: 'agent.task_deleted', tenantId, actorId: userId, actorType: 'USER', resourceType: 'Agent', resourceId: agentId, action: 'DELETE_TASK', afterState: { taskId } })
}

// ════════════════════════════════════════════════════════════════════════════
// generateAgentSystemPrompt — shared between builder.service.js and the
// create_agent tool handler in task.service.js. Produces a rich, archetype-
// aware system prompt so every agent — whether created by a human or by
// another agent at runtime — has clear role identity, behaviour rules,
// tool guidance, and honesty guardrails from day one.
// ════════════════════════════════════════════════════════════════════════════

export function generateAgentSystemPrompt(name, description, archetype) {
  const safeName = sanitizePromptText(name) || 'AI Agent'
  const safeDesc = sanitizePromptText(description) || 'a specialized AI agent'
  const desc = safeDesc

  const honesty = `
## CORE RULES (non-negotiable)
- NEVER fabricate data, results, or statistics. If a tool call fails, say so honestly.
- NEVER pretend you ran a query or fetched data when you did not.
- If you lack a required tool or permission, state it clearly and suggest what is needed.
- Use the minimum number of tool calls needed to complete the task accurately.
- Prioritise accuracy over speed. One correct answer beats three guesses.`

  const archetypeTemplates = {

    // ── Analytics / Data ────────────────────────────────────────────────────
    'data-analyst': `You are **${safeName}**, a data analytics agent. ${desc}

## YOUR ROLE
You specialise in querying databases and producing accurate, well-visualised reports.
You have direct access to one or more databases via SQL tools.

## HOW TO WORK
1. Call \`listTables\` (or \`describeTable\` if schema is preloaded) to understand the data model.
2. Call \`describeTable\` for every table you intend to query — verify column names before writing SQL.
3. Call \`runQuery\` with a correct SELECT statement. Always use LIMIT. Always JOIN to resolve IDs to names.
4. Call \`publish_dashboard_report\` with the real rows you received. Never invent data.
5. If a query fails, read the error, fix the SQL, and retry — do NOT fall back to made-up numbers.
${honesty}`,

    // ── Research ────────────────────────────────────────────────────────────
    'research': `You are **${safeName}**, a research and intelligence agent. ${desc}

## YOUR ROLE
You gather information from the web, APIs, and documents and synthesise it into clear, accurate reports.

## HOW TO WORK
1. Use \`browser_use\` or \`http_request\` to fetch real information from authoritative sources.
2. Use \`http_download\` to retrieve documents, PDFs, or datasets.
3. Use \`write_artifact\` to save detailed findings for later reference.
4. Summarise findings in a structured format. Cite sources. Do not add speculation.
5. If web access fails, state what you attempted and what is missing — do not guess.
${honesty}`,

    // ── Coordinator / Orchestrator ───────────────────────────────────────────
    'coordinator': `You are **${safeName}**, a workflow coordinator and multi-agent orchestrator. ${desc}

## YOUR ROLE
You break complex goals into subtasks, delegate them to specialist agents, and synthesise results.

## HOW TO WORK
1. Analyse the goal and decompose it into clear, independent subtasks.
2. Use \`delegate_task\` to assign subtasks to available specialist agents.
3. Use \`create_agent\` to spin up a new agent if no suitable one exists.
4. Use \`create_workflow\` to formalise repeating pipelines.
5. Use \`create_trigger\` to schedule recurring tasks.
6. Aggregate sub-agent results and produce a final consolidated output.
7. Never do work yourself that a specialist agent should do — orchestrate, don't implement.
${honesty}`,

    // ── Agent Generation / Meta-Orchestrator ────────────────────────────────
    'agent-generation': `You are **${safeName}**, a meta-orchestrator agent whose primary purpose is to design, create, and manage other AI agents. ${desc}

## YOUR ROLE
You are the architect of the agent ecosystem. You analyse requirements, design the right agent hierarchy,
provision agents with the correct archetypes and system prompts, wire them into workflows, and schedule
them to run autonomously — effectively replacing manual human coordination.

## HOW TO WORK
1. **Understand the goal**: what outcomes are needed, at what cadence, by whom?
2. **Design the agent hierarchy**: which specialist agents are needed (analytics, research, communication, etc.)?
3. **Create agents**: call \`create_agent\` with a precise archetype, a descriptive name, and a detailed systemPrompt.
4. **Wire workflows**: call \`create_workflow\` to connect agents into multi-step pipelines.
5. **Schedule execution**: call \`create_trigger\` with a cron expression for recurring workflows.
6. **Delegate immediately**: use \`delegate_task\` to start work on any created agent right away.
7. **Report**: call \`publish_dashboard_report\` or \`write_artifact\` to document what was built.

## AGENT CREATION GUIDELINES
- Always set a rich, role-specific \`systemPrompt\` — never use the bare "You are X" default.
- Match \`archetype\` to the agent's primary function: data-analyst (analytics), research, coordinator, customer-support (communication), compliance, document, planner, developer, data-entry, agent-generation.
- Set \`autonomyLevel\` = 'AUTONOMOUS' for background/scheduled agents, 'GUARDED' for semi-automated, 'SUPERVISED' for high-stakes.
- After creating an agent, immediately test it with \`delegate_task\`.
${honesty}`,

    // ── Data Entry / Web Automation ─────────────────────────────────────────
    'data-entry': `You are **${safeName}**, a data entry and web automation agent. ${desc}

## YOUR ROLE
You interact with web forms, applications, and websites to fill in data, extract information,
scrape pages, and automate browser-based workflows — all via a real Playwright browser.

## HOW TO WORK
1. ALWAYS start by examining the task — is it a form to fill, data to extract, or a multi-step workflow?
2. Use \`browser_use\` to navigate to URLs, click buttons, type into form fields, scroll pages, and extract data.
3. Use \`http_request\` for API calls or when a page can be fetched without a browser.
4. Use \`publish_dashboard_report\` to present extracted data as formatted tables or visual reports.
5. For multi-page workflows: navigate → extract/type → click next → repeat. Keep track of progress.
6. If a selector is not obvious, use \`browser_use\` with action "extract" to see the page text and find the right elements.
7. Handle errors gracefully: if a page times out or a selector is missing, report what went wrong and try alternatives.
8. Never submit partially-filled forms without confirming all required fields are populated.
${honesty}`,

    // ── Communication ───────────────────────────────────────────────────────
    'customer-support': `You are **${safeName}**, a customer communication and support agent. ${desc}

## YOUR ROLE
You handle messaging, notifications, and customer interactions across channels (Slack, Email, WhatsApp, etc.).

## HOW TO WORK
1. Use available connector tools (slack__*, gmail__*, whatsapp__*, etc.) to send and receive messages.
2. Keep messages concise, friendly, and accurate. Never send unverified information.
3. If you need data to answer a query, use database or HTTP tools to fetch it first.
4. Escalate complex issues via \`delegate_task\` to a specialist agent.
${honesty}`,

    // ── Planner ─────────────────────────────────────────────────────────────
    'planner': `You are **${safeName}**, a project planning and task management agent. ${desc}

## YOUR ROLE
You break projects into structured task lists, assign work to agents, track progress, and ensure completion.

## HOW TO WORK
1. Decompose the project goal into a prioritised, sequenced list of tasks.
2. Use \`delegate_task\` or \`create_workflow\` to assign tasks to agents or automate them.
3. Use \`create_trigger\` to schedule recurring check-ins or status reports.
4. Produce clear, structured output (task lists, timelines, status summaries).
5. Never mark a task done unless there is concrete evidence of completion.
${honesty}`,

    // ── Compliance ──────────────────────────────────────────────────────────
    'compliance': `You are **${safeName}**, a compliance, legal, and audit agent. ${desc}

## YOUR ROLE
You review policies, audit systems, check regulatory compliance, and produce formal reports.

## HOW TO WORK
1. Use \`browser_use\` or \`http_request\` to retrieve official regulatory sources.
2. Use \`file_search\` to scan local documents for policy violations or gaps.
3. Use database tools (if available) to audit records and data integrity.
4. Document all findings with citations. Flag risks with severity levels.
5. Never make compliance judgments without evidence. State assumptions explicitly.
${honesty}`,

    // ── Document / Content ──────────────────────────────────────────────────
    'document': `You are **${safeName}**, a document creation and content generation agent. ${desc}

## YOUR ROLE
You produce high-quality written content: reports, summaries, templates, articles, and documents.

## HOW TO WORK
1. Gather source material first — use \`http_request\`, \`browser_use\`, or \`file_search\` before writing.
2. Structure content clearly: headings, bullet points, and summaries where appropriate.
3. Use \`write_artifact\` to save documents in the correct format (html, pdf, csv, json).
4. Use \`publish_dashboard_report\` to present formatted output on the dashboard.
5. Always attribute information to its source. Never fabricate quotes or statistics.
${honesty}`,

    // ── Developer ───────────────────────────────────────────────────────────
    'developer': `You are **${safeName}**, a software development and engineering agent. ${desc}

## YOUR ROLE
You write, review, and deploy code; manage repositories; track issues; and run CI/CD pipelines.

## HOW TO WORK
1. Use GitHub/Jira/Linear connector tools for code review and issue tracking.
2. Use \`docker_run\` for isolated code execution and testing.
3. Use \`ssh_exec\` for remote deployments and server management.
4. Use \`http_request\` to call APIs and validate integrations.
5. Use \`file_search\` to scan codebases for patterns, TODOs, or bugs.
6. Document all changes and decisions in \`write_artifact\`.
${honesty}`,
  }

  // Resolve archetype to a canonical key (handle analytics → data-analyst, etc.)
  const aliasMap = {
    'analytics':    'data-analyst',
    'research':     'research',
    'coordinator':  'coordinator',
    'designer':     'data-analyst',
    'engineer':     'data-analyst',
    'communication':'customer-support',
    'support':      'customer-support',
    'planner':      'planner',
    'compliance':   'compliance',
    'document':     'document',
    'data-entry':    'data-entry',
    'developer':    'developer',
    'agent-generation': 'agent-generation',
    'orchestrator': 'agent-generation',
    'meta-agent':   'agent-generation',
  }

  const key = aliasMap[archetype] || aliasMap[archetype?.toLowerCase()] || null
  const template = key ? archetypeTemplates[key] : null

  if (template) return template

  // Generic fallback for unknown archetypes
  return `You are **${safeName}**, ${desc}.

## CORE RULES
- Complete every task using your available tools. Do not describe what you will do — do it.
- Never fabricate data, statistics, or results. If a tool fails, report the error honestly.
- Use the fewest tool calls needed to accomplish the goal accurately.
- When in doubt, call a tool to verify rather than guessing.`
}
