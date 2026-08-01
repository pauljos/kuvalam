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

  // If no system prompt provided, generate one from the archetype template
  let safeSystemPrompt = sanitizePromptText(data.systemPrompt)
  if (!safeSystemPrompt && data.archetype) {
    safeSystemPrompt = await generateAgentSystemPrompt(data.name, data.description, data.archetype, tenantId)
  }

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
     data.llmProvider || 'openai', data.llmModel || 'auto', safeSystemPrompt,
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
    `SELECT a.*, t.llm_config,
      (SELECT json_agg(row_to_json(s)) FROM agent_skills s WHERE s.agent_id = a.id AND s.is_enabled = true) as skills,
      (SELECT json_agg(row_to_json(r) ORDER BY r.priority) FROM agent_rules r WHERE r.agent_id = a.id AND r.is_active = true) as rules,
      (SELECT json_agg(kb.id) FROM agent_knowledge_bases akb JOIN knowledge_bases kb ON kb.id = akb.knowledge_base_id WHERE akb.agent_id = a.id) as knowledge_base_ids,
      (SELECT json_agg(kg.id) FROM agent_knowledge_graphs akg JOIN knowledge_graphs kg ON kg.id = akg.knowledge_graph_id WHERE akg.agent_id = a.id) as knowledge_graph_ids
     FROM agents a
     JOIN tenants t ON t.id = a.tenant_id
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
  // Fetch current state BEFORE update for audit trail AND prompt-history snapshot
  const { rows: [before] } = await query(
    'SELECT name, llm_model, llm_provider, status, system_prompt FROM agents WHERE id = $1 AND tenant_id = $2',
    [agentId, tenantId]
  )
  if (!before) throw new AppError('AGENT_NOT_FOUND', 'Agent not found', 404)

  const allowed = ['name','description','system_prompt','archetype','autonomy_level','llm_provider','llm_model','confidence_threshold','max_actions_per_run','report_dir','compress_system_prompt','chunked_prompt','local_refine_prompt']
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

  // ── Prompt version history ──────────────────────────────────────────────
  // If system_prompt is being changed, snapshot the CURRENT value onto the
  // history stack first so the user can undo a refine/edit. Bounded to last 20.
  const PROMPT_HISTORY_LIMIT = 20
  const promptChanged = Object.prototype.hasOwnProperty.call(mapped, 'system_prompt')
    && (mapped.system_prompt || '') !== (before.system_prompt || '')
  if (promptChanged) {
    await query(
      `UPDATE agents SET system_prompt_history = (
         SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb) FROM (
           SELECT elem FROM jsonb_array_elements(
             COALESCE(system_prompt_history, '[]'::jsonb) || jsonb_build_array($3::jsonb)
           ) WITH ORDINALITY AS t(elem, ord) ORDER BY ord DESC LIMIT $4
         ) kept
       ) WHERE id = $1 AND tenant_id = $2`,
      [agentId, tenantId, JSON.stringify({
        prompt: before.system_prompt || '',
        savedAt: new Date().toISOString(),
        savedBy: userId || null
      }), PROMPT_HISTORY_LIMIT]
    )
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

// ── Prompt version history ────────────────────────────────────────────────────
// Return the saved prompt-version stack (newest last) for an agent.
export async function getPromptHistory(tenantId, agentId) {
  const { rows: [agent] } = await query(
    'SELECT system_prompt, system_prompt_history FROM agents WHERE id = $1 AND tenant_id = $2',
    [agentId, tenantId]
  )
  if (!agent) throw new AppError('AGENT_NOT_FOUND', 'Agent not found', 404)
  const history = Array.isArray(agent.system_prompt_history) ? agent.system_prompt_history : []
  return {
    current: agent.system_prompt || '',
    // Present newest-first for the UI.
    versions: [...history].reverse().map((v, i) => ({
      index: history.length - 1 - i,
      prompt: v.prompt || '',
      savedAt: v.savedAt || null,
      savedBy: v.savedBy || null
    })),
    count: history.length
  }
}

// Pure decision logic for undo: which entry to restore and what remains on the
// stack afterwards. Exported for unit tests — no DB access.
export function computePromptUndo(history, index = null) {
  const stack = Array.isArray(history) ? [...history] : []
  if (stack.length === 0) throw new AppError('NO_HISTORY', 'No previous prompt version to restore', 409)
  // Default: the newest entry (top of stack). A specific index restores that
  // version and drops it (and everything after it) from the stack.
  const idx = index === null ? stack.length - 1 : Number(index)
  if (!Number.isInteger(idx) || idx < 0 || idx >= stack.length) {
    throw new AppError('BAD_INDEX', `Version index out of range (0..${stack.length - 1})`, 400)
  }
  return { idx, restore: stack[idx], remaining: stack.slice(0, idx) }
}

// Restore the most recent prompt version (pop the newest history entry back
// into system_prompt). Optionally restore a specific version by index.
export async function undoPromptChange(tenantId, agentId, userId, index = null) {
  const { rows: [agent] } = await query(
    'SELECT system_prompt, system_prompt_history FROM agents WHERE id = $1 AND tenant_id = $2',
    [agentId, tenantId]
  )
  if (!agent) throw new AppError('AGENT_NOT_FOUND', 'Agent not found', 404)
  const { idx, restore, remaining } = computePromptUndo(agent.system_prompt_history, index)

  const { rows: [updated] } = await query(
    `UPDATE agents SET system_prompt = $3, system_prompt_history = $4 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [agentId, tenantId, restore.prompt || '', JSON.stringify(remaining)]
  )

  await auditLog({
    eventType: 'agent.prompt_restored', tenantId, actorId: userId, actorType: 'USER',
    resourceType: 'Agent', resourceId: agentId, action: 'UPDATE',
    metadata: { restoredIndex: idx, restoredSavedAt: restore.savedAt || null, remainingVersions: remaining.length }
  })
  return { agent: updated, restored: { index: idx, prompt: restore.prompt || '', savedAt: restore.savedAt || null }, remaining: remaining.length }
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

// Refine an agent's custom system instructions (guardrails & constraints) based
// on a scenario/rule the user wants the agent to follow. Uses the agent's own
// configured LLM, with a deterministic fallback when the model can't produce
// structured output. Does NOT auto-save — the caller previews and applies.
export async function refineAgentPrompt(tenantId, agentId, scenario, currentSystemPrompt, currentGoal) {
  const { rows: [agent] } = await query(
    `SELECT a.*, t.llm_config FROM agents a JOIN tenants t ON t.id = a.tenant_id WHERE a.id = $1 AND a.tenant_id = $2`,
    [agentId, tenantId]
  )
  if (!agent) throw new AppError('AGENT_NOT_FOUND', 'Agent not found', 404)

  // Fetch agent skills so the LLM understands what tools the agent has
  const { rows: skills } = await query(
    `SELECT name, description FROM agent_skills WHERE agent_id = $1 AND tenant_id = $2`,
    [agentId, tenantId]
  )

  // Fetch knowledge bases attached to the agent
  const { rows: kbs } = await query(
    `SELECT kb.name, kb.description FROM knowledge_bases kb
     JOIN agent_knowledge_bases akb ON akb.knowledge_base_id = kb.id
     WHERE akb.agent_id = $1`,
    [agentId]
  )

  // Refine ONLY the user-authored guardrails, not the archetype template. The
  // stored system_prompt may contain a frozen archetype blob — strip it so we
  // don't bake the template back in when the refined result is saved.
  const { extractUserGuardrails, buildSystemPrompt } = await import('./task-reports.js')
  const rawExisting = (currentSystemPrompt !== undefined ? currentSystemPrompt : agent.system_prompt) || ''

  // Build the full system prompt (archetype + guardrails) so the LLM sees the
  // complete agent persona, not just the stripped guardrails.
  let fullSystemPrompt = rawExisting
  try {
    fullSystemPrompt = await buildSystemPrompt(agent, skills, currentGoal || scenario) || rawExisting
  } catch { /* fall through to rawExisting */ }

  const existing = extractUserGuardrails(rawExisting)
  const cleanScenario = sanitizePromptText(scenario).slice(0, 1000)
  const cleanGoal = sanitizePromptText(currentGoal || scenario).slice(0, 1000)

  // Normalise: strip any stale section headings from the extracted guardrails and
  // persona prefix so we don't double them up during merge.  Previous version of
  // this function could corrupt the stored system_prompt by stacking headings.
  const stripHeadings = (s) => s
    .replace(/^##\s+AGENT[- ]SPECIFIC\s+INSTRUCTIONS\s*$/gim, '')
    .replace(/^##\s+Guardrails?\s*(\(.*\))?\s*$/gim, '')
    .trim()
  const personaPrefix = stripHeadings(rawExisting.replace(existing, ''))

  // Helper: build the final system prompt from the complete guardrails list.
  // The LLM now returns the FULL updated guardrails (not deltas), so we replace
  // cleanExisting entirely — old irrelevant rules are dropped.
  const buildSystem = (guardrails) => {
    const lines = guardrails.map(r => `- ${r}`).join('\n')
    return personaPrefix
      ? `${personaPrefix}\n\n## AGENT-SPECIFIC INSTRUCTIONS\n${lines}`
      : `## AGENT-SPECIFIC INSTRUCTIONS\n${lines}`
  }

  // Build a template-based fallback upfront — used both for LLM errors and
  // low-quality LLM output (common with smaller models like qwen3:4b).
  const archetypeKey = (agent.archetype || 'generalist').toLowerCase()
  const templateGuardrails = expandGuardrailsFromTemplate(cleanScenario, archetypeKey, agent.name || '')
  const templateGoal = expandGoalFromTemplate(cleanScenario, archetypeKey)

  const fallback = {
    updatedSystemPrompt: buildSystem(templateGuardrails),
    refinedGoal: templateGoal,
    summary: `Auto-generated ${templateGuardrails.length} detailed guardrails for "${cleanScenario.slice(0, 60)}".`,
    guardrails: templateGuardrails,
    usedFallback: true
  }

  try {
    const { complete } = await import('./llm.service.js')
    const systemMsg = `You are an expert AI prompt engineer. Your job is to write DETAILED, comprehensive instructions that turn a rough goal into a complete operating procedure for an AI agent.

GUIDELINES:
- Be thorough. A one-line guardrail is a FAILURE. Each guardrail should be 2-4 sentences of SPECIFIC, ACTIONABLE technical guidance.
- Think like a domain expert. If the goal is "design a 5-story building", write like a structural engineer — reference codes, load paths, materials, safety factors, drawing standards.
- Produce 5-10 guardrails for any non-trivial task. More is better than fewer.
- Cover: workflow steps, tool usage, quality checks, edge cases, output format, constraints, and what NOT to do.
- Preserve existing guardrails that are still relevant. Drop only what's clearly outdated.
- The refined goal should be 2-4 sentences: what, how, with what tools, and what success looks like.

Return STRICT JSON ONLY — no markdown fences, no commentary, no trailing commas.
JSON shape:
{"refinedGoal":"<comprehensive goal — 2 to 4 sentences>","guardrails":["<detailed guardrail 1 — 2-4 sentences>","<guardrail 2>",...],"summary":"<1 sentence summary of what you added/changed>"}`

    const skillLines = skills.length > 0
      ? skills.map(s => `- ${s.name}: ${s.description || ''}`).join('\n')
      : '(none)'
    const kbLines = kbs.length > 0
      ? kbs.map(k => `- ${k.name}: ${k.description || ''}`).join('\n')
      : '(none)'

    const userMsg = `--- AGENT FULL SYSTEM PROMPT (role, persona, tools, knowledge, guardrails) ---
${fullSystemPrompt.slice(0, 4000)}
--- END ---

Agent name: ${agent.name || ''}
Agent description: ${agent.description || ''}
Archetype: ${agent.archetype || 'coordinator'}
Skills/tools available:
${skillLines}
Knowledge bases attached:
${kbLines}

--- EXISTING CUSTOM GUARDRAILS (keep what's still relevant, drop what's not) ---
${existing || '(none — this is a fresh agent with no prior guardrails)'}
--- END ---

User's goal to turn into detailed instructions:
${cleanGoal}`

    // ── debug: log the full prompt sent to the LLM ──
    console.log('═══════════════════════════════════════════════════════════')
    console.log(`[refineAgentPrompt] Agent: ${agent.name} (${agentId})`)
    console.log(`[refineAgentPrompt] Scenario: ${cleanScenario}`)
    console.log(`[refineAgentPrompt] Goal: ${cleanGoal}`)
    console.log(`[refineAgentPrompt] Existing guardrails length: ${existing.length}`)
    console.log(`[refineAgentPrompt] Full system prompt length: ${fullSystemPrompt.length}`)
    console.log(`[refineAgentPrompt] useSystemLlm: ${!agent.llm_provider}, provider: ${agent.llm_provider || 'system'}, model: ${agent.llm_model || 'system'}`)
    console.log('───────────────────────────────────────────────────────────')
    console.log('[refineAgentPrompt] SYSTEM MESSAGE:')
    console.log(systemMsg)
    console.log('───────────────────────────────────────────────────────────')
    console.log('[refineAgentPrompt] USER MESSAGE:')
    console.log(userMsg)
    console.log('═══════════════════════════════════════════════════════════')

    const res = await complete({
      tenantId,
      agentId,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: userMsg }
      ],
      model: agent.llm_model,
      temperature: 0.2,
      llmConfig: agent.llm_config || {},
      provider: agent.llm_provider,
      useSystemLlm: !agent.llm_provider,
      maxTokens: 4000
    })

    console.log('[refineAgentPrompt] RAW LLM RESPONSE:')
    console.log(JSON.stringify(res.content, null, 2).slice(0, 2000))
    console.log('═══════════════════════════════════════════════════════════')

    const parsed = parseRefineJson(res.content)
    if (parsed && typeof parsed.refinedGoal === 'string' && parsed.refinedGoal.trim()) {
      const rawGuardrails = Array.isArray(parsed.guardrails) && parsed.guardrails.length > 0
        ? parsed.guardrails.map(r => String(r).slice(0, 800))
        : []

      // Detect low-quality output from small LLMs (qwen3:4b etc.): if the
      // guardrails are just the user's input rephrased, expand them via template.
      const isLowQuality = rawGuardrails.length < 3
        || rawGuardrails.every(r => r.length < 40)
        || rawGuardrails.some(r => r.toLowerCase().includes(cleanScenario.toLowerCase()) && r.length < 80)

      const guardrails = isLowQuality
        ? expandGuardrailsFromTemplate(cleanScenario, agent.archetype || 'generalist', agent.name || '')
        : rawGuardrails
      const usedFallback = isLowQuality

      return {
        updatedSystemPrompt: buildSystem(guardrails),
        refinedGoal: isLowQuality
          ? expandGoalFromTemplate(cleanScenario, agent.archetype || 'generalist')
          : sanitizePromptText(parsed.refinedGoal).slice(0, 1000),
        summary: isLowQuality
          ? `Auto-generated ${guardrails.length} detailed guardrails from template (model output was too sparse).`
          : String(parsed.summary || `Refined goal and guardrails`).slice(0, 500),
        guardrails,
        usedFallback
      }
    }
  } catch (err) {
    console.warn(`[refineAgentPrompt] LLM failed (${err.message}) — using deterministic fallback`)
  }
  return fallback
}

// ── Template-based guardrail expansion (fallback when small LLMs fail) ──────

const GUARDRAIL_TEMPLATES = {
  engineering: (scenario, name) => [
    `Structural analysis: For "${scenario}", begin by identifying all load cases — dead loads (self-weight), live loads (occupancy per local code), wind loads, and seismic loads where applicable. Calculate each separately before combining per the relevant load combination standard (ASCE 7, Eurocode 0, IS 456).`,
    `Material selection: Specify concrete grade, steel reinforcement grade, and any specialty materials. For a multi-story structure, consider M25-M40 concrete and Fe500-Fe550 reinforcement as starting points. Document the rationale for each material choice with reference to cost, availability, and code compliance.`,
    `Code compliance: Reference the applicable structural design codes throughout your work — IS 456:2000 and SP 16 for Indian projects, ACI 318 for US, Eurocode 2 for EU. For every calculation, cite the specific clause or table used. Never proceed without stating which code governs.`,
    `Drawing standards: Produce SVG or HTML drawings with clear labels, dimensions in mm, reinforcement detailing, column/beam schedules, and foundation layout. Every drawing must include: title block, scale bar, north arrow (for plans), revision date, and your name as designer. Use standard line weights — thick for structural elements, thin for dimensions.`,
    `Safety factors: Always apply the code-specified partial safety factors — typically 1.5 for concrete, 1.15 for steel reinforcement, and appropriate load factors (1.2 DL + 1.6 LL minimum). Never round down safety factors. Flag any assumptions about soil bearing capacity, wind speed, or seismic zone explicitly.`,
    `Foundation design: Based on the column loads from the superstructure analysis, design appropriate foundations — isolated footings for good soil, raft foundation for weak soil, piles for deep foundations. Calculate bearing pressure, check against allowable, and detail reinforcement accordingly.`,
    `Quality checks: Before finalizing any output, self-review: (a) Are all units consistent and explicitly stated? (b) Have you run a sanity check on the numbers (e.g., steel percentage within 0.8-4% for columns)? (c) Is every number traceable to a calculation step? If any check fails, go back and fix it.`,
    `Documentation: Save all work using write_artifact — structural analysis report as HTML/PDF, beam/column schedules as CSV tables, drawings as SVG. Publish a summary dashboard report with publish_dashboard_report showing key metrics: total dead load, total live load, max bending moment, max shear, max deflection.`,
  ],
  scientific: (scenario, name) => [
    `Hypothesis & methodology: For "${scenario}", clearly state the hypothesis or research question before beginning. Define the methodology — experimental, computational, or literature review — and justify why it's appropriate. Outline the steps before executing.`,
    `Data sources: Identify and fetch data from authoritative sources — PubChem for chemical properties, PDB/GenBank for biomolecular data, NIST for physical constants, arXiv/PubMed for literature. Use http_request or browser_use for web sources. Always record the accession date and URL for every external data source.`,
    `Calculations & units: Perform calculations step by step with explicit formulas. Use SI units unless the domain standard is different. Include uncertainty estimates (±) for every measurement. For computational work, specify the software/method, basis set (for quantum), force field (for MD), or algorithm used.`,
    `Error analysis: Quantify errors — systematic vs random, propagation through calculations, significant figures. Never report a result with more precision than the input data warrants. Use the standard deviation or confidence interval appropriate to the method.`,
    `Visualization: Use write_artifact to generate SVG diagrams — molecular structures, reaction schemes, phylogenetic trees, crystal lattices, Feynman diagrams as appropriate. Use publish_dashboard_report for data charts with properly labeled axes, error bars, and legends.`,
    `References: Cite all sources in a standard format (APA, ACS, or Vancouver). For each reference, include at minimum: author, year, title, journal/DOI. Distinguish clearly between peer-reviewed sources, preprints, and grey literature.`,
    `Reproducibility: Document every step so another researcher could reproduce your work. Include: raw data (as CSV/JSON via write_artifact), processing scripts, parameter values, random seeds (for stochastic methods), and software versions.`,
    `Ethics & limitations: For biology/medical work, note ethical constraints. State limitations honestly — sample size, confounding variables, model assumptions. Never overstate confidence. If the data doesn't support a conclusion, say so.`,
  ],
  medical: (scenario, name) => [
    `Evidence hierarchy: For "${scenario}", prioritize systematic reviews and meta-analyses from Cochrane, then RCTs from PubMed/ClinicalTrials.gov, then observational studies. For each finding, state the level of evidence (I-V) and grade of recommendation. Never present expert opinion as established fact.`,
    `Source verification: Use http_request to query PubMed, FDA, WHO, or NICE guidelines. For every claim, cite: journal, authors, year, PMID or DOI, sample size, and study design. If a source is behind a paywall, note the abstract findings and the limitation.`,
    `Drug information: When discussing medications, include: generic name, brand names, mechanism of action, standard dosing, major side effects, contraindications, and drug interactions. Use DailyMed, Drugs.com, or BNF as references. Always include the disclaimer: "This is informational only — consult a healthcare professional."`,
    `Clinical context: Frame findings in clinical context — patient population, inclusion/exclusion criteria, primary vs secondary endpoints, number needed to treat (NNT), absolute risk reduction, not just relative. Distinguish between statistical significance and clinical significance.`,
    `Privacy & ethics: NEVER request, store, or process personal health information (PHI) unless explicitly required and encrypted. If a task involves patient data, stop and ask the user to confirm compliance with HIPAA/GDPR/local regulations before proceeding.`,
    `Output format: For literature reviews, use write_artifact to save structured summaries with: background, methods, results, discussion, limitations. For drug comparisons, use tables with columns: drug, class, dose, efficacy, side effects, cost, guideline recommendation. Publish dashboard reports for executive summaries.`,
    `Limitations & disclaimers: Begin every output with: "This is AI-generated informational content — not medical advice. Always consult a qualified healthcare professional." Never claim diagnostic or prescriptive capability. End with recommendations for further reading or specialist consultation.`,
  ],
  'data-analyst': (scenario, name) => [
    `Schema discovery: For "${scenario}", first call listTables and describeTable to understand the data model. Never write a query without confirming column names, data types, and relationships. Document the schema you discovered before querying.`,
    `Query construction: Write SQL with explicit column lists (no SELECT *), appropriate JOINs on indexed foreign keys, WHERE clauses that leverage indexes, and sensible LIMIT clauses. Test edge cases: NULL handling, empty result sets, large date ranges. If a query errors, read the error message, fix the SQL, retry — never fabricate results.`,
    `Data quality: Before reporting, check for: NULL counts in key columns, duplicate rows, outliers (values > 3σ from mean), date range sanity, and referential integrity (orphaned FK references). Flag any quality issues in the report.`,
    `Visualization: Use publish_dashboard_report with appropriate chart types — line charts for time series, bar charts for categories, scatter plots for correlations, heatmaps for matrices. Include: title, labeled axes with units, legend, data source note, and generation timestamp.`,
    `Analysis narrative: For every dashboard or report, include a written narrative: (a) what the data shows, (b) key trends/patterns, (c) anomalies or caveats, (d) actionable recommendations. Never just present numbers without interpretation.`,
    `Performance: Use EXPLAIN ANALYZE on complex queries. If a query scans >10K rows, add indexes or rewrite. Cache results that don't change between runs. Break large reports into paginated chunks.`,
  ],
  developer: (scenario, name) => [
    `Code analysis: For "${scenario}", first understand the codebase — use file_search to find relevant files, read existing tests, check the README and package.json. Never modify code without understanding its context and dependencies.`,
    `Implementation plan: Break the task into atomic commits. Write the plan as: (1) what files change, (2) what the change is, (3) how to test it, (4) rollback plan. Share the plan before coding if the change is non-trivial.`,
    `Code quality: Follow the project's existing conventions — ESLint/Prettier config, TypeScript strictness, naming patterns, folder structure. Write self-documenting code with clear variable names. Add JSDoc/docstrings for public APIs. Run linting and tests before considering any change complete.`,
    `Testing: Write or update unit tests for new code. Test edge cases: empty inputs, null/undefined, large payloads, error paths. Run the full test suite and confirm all pass. If tests were already failing, note them but don't block on pre-existing failures.`,
    `Git workflow: Use descriptive commit messages following conventional commits (feat:, fix:, refactor:, test:, docs:). Create a branch if the repo supports it. Never force-push to main/master. Use write_artifact for code review summaries and PR descriptions.`,
    `Error handling: All async operations must have try/catch with meaningful error messages. HTTP clients must handle: timeouts, 4xx, 5xx, network errors. Never swallow errors silently — log them with context.`,
    `Deployment awareness: If the task involves deployment, check: environment variables, build scripts, Docker config, CI/CD pipeline. Never deploy to production without explicit confirmation. Use ssh_exec for remote commands only after verifying the target host.`,
  ],
  research: (scenario, name) => [
    `Research strategy: For "${scenario}", plan your research before executing — define search queries, identify authoritative sources, set scope boundaries. Use browser_use for web research and http_request for API access to databases and knowledge bases.`,
    `Source evaluation: For every source, assess: authority (who published it?), currency (when?), accuracy (peer-reviewed?), purpose (bias?). Prefer .gov, .edu, and established industry sources over blogs and social media. Score sources on a simple A/B/C reliability scale.`,
    `Synthesis: Don't just list sources — synthesize findings into a coherent narrative. Identify agreements and disagreements across sources. Highlight consensus views vs minority opinions. Note research gaps where evidence is thin.`,
    `Output format: Use write_artifact for detailed research briefs (HTML with TOC, sections, citations). Use publish_dashboard_report for executive summaries with key findings, source count, confidence rating, and recommended actions.`,
    `Citation: Every factual claim must have a source. Use inline citations or footnotes. Include: title, author/org, URL, access date. Use http_download to cache PDFs or key pages for offline reference.`,
  ],
  iot: (scenario, name) => [
    `Device inventory: For "${scenario}", first identify the relevant devices — sensors, actuators, gateways, PLCs. Document: device type, communication protocol (MQTT, Modbus, OPC-UA, BLE), data format (JSON, binary, CSV), sampling rate, and physical location.`,
    `Data pipeline: Use http_request to query device APIs or MQTT brokers. Parse the telemetry — check for timestamp consistency, out-of-range values, and missing data gaps. Use database tools to store and query time-series data with appropriate retention.`,
    `Anomaly detection: For each metric, establish normal operating ranges. Flag values outside 2σ (warning) and 3σ (critical) bands. Correlate anomalies across sensors — a temperature spike + vibration spike together is more significant than either alone.`,
    `Safety & reliability: For industrial/safety-critical systems, never assume defaults are safe. Verify: fail-safe modes, watchdog timers, communication timeouts, power-loss behavior. Flag any system that lacks redundancy for critical functions.`,
    `Reporting: Use publish_dashboard_report to visualize device telemetry — time-series charts for trends, gauges for current values, heatmaps for spatial data. Include device health score (0-100) based on uptime, error rate, and data quality.`,
  ],
  generalist: (scenario, name) => [
    `Task analysis: For "${scenario}", break down what's being asked — what type of task is this (analysis, creation, research, automation)? What tools are needed? What does success look like? Clarify ambiguities before starting.`,
    `Tool selection: Choose the right tool for each step: browser_use for web interaction, http_request for API calls, file_search for code/docs, write_artifact for persistent output, publish_dashboard_report for visual results. Don't use a complex tool when a simple one works.`,
    `Step-by-step execution: Work through tasks methodically. Complete each step before moving to the next. Report progress as you go — what you did, what you found, what's next. If a step fails, diagnose the error and try an alternative approach.`,
    `Quality standards: Every output should be: accurate (fact-checked, not guesswork), complete (addresses all parts of the request), clear (well-structured, jargon explained), and honest (limitations stated, uncertainties flagged).`,
    `Documentation: Save important intermediate results with write_artifact. Publish final deliverables with publish_dashboard_report. Include: timestamp, your name as the agent, methodology summary, and any assumptions made.`,
  ],
}

export function expandGuardrailsFromTemplate(scenario, archetype, agentName = '') {
  const key = (archetype || 'generalist').toLowerCase()
  const templateFn = GUARDRAIL_TEMPLATES[key] || GUARDRAIL_TEMPLATES['generalist']
  return templateFn(scenario, agentName)
}

export function expandGoalFromTemplate(scenario, archetype) {
  const key = (archetype || 'generalist').toLowerCase()
  const goals = {
    engineering: `Design and document ${scenario} following applicable structural codes. Perform load calculations, material selection, structural analysis, and produce detailed drawings (SVG) and calculation reports. Deliver a comprehensive design package with code references and safety factor justification.`,
    scientific: `Investigate ${scenario} using rigorous scientific methodology. Gather data from authoritative sources, perform calculations with uncertainty analysis, produce visualizations, and document findings with full reproducibility and proper citations.`,
    medical: `Research and summarize ${scenario} using evidence-based medical sources. Prioritize systematic reviews and RCTs from PubMed/Cochrane, cite all sources with PMID/DOI, and always include appropriate medical disclaimers.`,
    'data-analyst': `Analyze ${scenario} by exploring the database schema, writing optimized SQL queries, validating data quality, and publishing an interactive dashboard report with charts, key insights, and actionable recommendations.`,
    developer: `Implement ${scenario} following software engineering best practices. Understand the codebase, plan atomic changes, write clean tested code with proper error handling, and document the implementation.`,
    research: `Research ${scenario} by gathering and synthesizing information from authoritative web sources. Evaluate source credibility, cross-reference findings, and produce a structured research brief with citations and confidence ratings.`,
    iot: `Monitor and analyze ${scenario} by querying device telemetry, detecting anomalies, and publishing operational dashboards with sensor trends, device health scores, and alert summaries.`,
  }
  return goals[key] || `Complete ${scenario} using available tools and best practices. Plan each step, execute methodically, verify results, and document the outcome.`
}

export function parseRefineJson(content) {
  if (!content) return null
  const tryParse = (s) => { try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null } catch { return null } }
  const t = content.trim()

  // 1. whole content is JSON
  let o = tryParse(t)
  if (o) return o

  // 2. JSON inside a code fence
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) { o = tryParse(fence[1].trim()); if (o) return o }

  // 3. first balanced { ... } object anywhere in the text
  const start = t.indexOf('{')
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false
    for (let i = start; i < t.length; i++) {
      const c = t[i]
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) { o = tryParse(t.slice(start, i + 1)); if (o) return o; break } }
    }
  }
  return null
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

export async function generateAgentSystemPrompt(name, description, archetype, tenantId = null) {
  const safeName = sanitizePromptText(name) || 'AI Agent'
  const safeDesc = sanitizePromptText(description) || ''
  // If the description is just a placeholder (auto-generated at creation), leave
  // it blank — the archetype template already provides a good self-description.
  const isPlaceholder = !safeDesc
    || safeDesc === safeName
    || safeDesc === `Agent for: ${safeName}`
    || safeDesc.startsWith('Agent for:')
  const desc = isPlaceholder ? '' : safeDesc

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
- Match \`archetype\` to the agent's primary function:
  - **data-analyst** — SQL queries, dashboards, database reporting
  - **research** — web search, intelligence gathering, summarisation
  - **coordinator** — multi-agent orchestration, workflow management
  - **customer-support** — messaging, Slack/email/WhatsApp communication
  - **compliance** — policy review, regulatory audit, legal analysis
  - **document** — report writing, content generation, templates
  - **planner** — project planning, task decomposition, timelines
  - **developer** — code review, CI/CD, GitHub/Jira integration
  - **data-entry** — browser automation, form filling, web scraping
  - **engineering** — civil/structural/mechanical/architectural design and drawings
  - **scientific** — physics, chemistry, biology, mathematical modelling
  - **medical** — healthcare literature, clinical data, drug information
  - **news-media** — news monitoring, journalism, PR, media analysis
  - **insurance** — claims processing, risk assessment, underwriting
  - **banking** — financial analysis, KYC/AML, transaction monitoring
  - **iot** — sensor telemetry, embedded systems, device monitoring
  - **generalist** — versatile agent for mixed or undefined tasks
  - **agent-generation** — builds and manages other agents (meta-orchestrator)
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

    // ── Generalist ──────────────────────────────────────────────────────────
    'generalist': `You are **${safeName}**, a versatile AI agent. ${desc}

## YOUR ROLE
You handle a wide range of tasks across different domains. You are adaptable, pragmatic,
and use whatever tools are available to get the job done.

## HOW TO WORK
1. Analyse the goal carefully — what kind of task is this (research, coding, data, automation, communication)?
2. Pick the right tool for the job: \`http_request\` for web data, \`browser_use\` for web interaction,
   \`file_search\` for local files, \`write_artifact\` to save output, \`publish_dashboard_report\` for reports.
3. If the task is too large, break it into steps and tackle them one at a time.
4. Report progress as you go. If you get stuck, explain what you need.
5. Adapt your approach based on results — don't repeat the same mistake twice.
${honesty}`,

    // ── News & Media ─────────────────────────────────────────────────────────
    'news-media': `You are **${safeName}**, a news and media intelligence agent. ${desc}

## YOUR ROLE
You monitor news sources, track media coverage, research stories, generate articles,
and produce media analysis reports. You are the go-to agent for journalism, PR,
and content teams who need real-time news aggregation and synthesis.

## HOW TO WORK
1. Use \`http_request\` to fetch from news APIs, RSS feeds, and media sources.
2. Use \`browser_use\` to browse news websites, press releases, and media portals.
3. Use \`http_download\` to retrieve full articles, PDFs, or media datasets.
4. Cross-reference stories across multiple sources — flag bias, discrepancies, and unverified claims.
5. Use \`write_artifact\` to save articles, press releases, media briefs, and newsletters (HTML/PDF).
6. Use \`publish_dashboard_report\` to present news summaries, trend analyses, and media dashboards.
7. Always cite sources with URLs and publication dates. Distinguish between facts, analysis, and opinion.
8. For breaking news, prioritise recency but verify through at least two independent sources before reporting.
${honesty}`,

    // ── Insurance ────────────────────────────────────────────────────────────
    'insurance': `You are **${safeName}**, an insurance and risk analysis agent. ${desc}

## YOUR ROLE
You process insurance claims, analyse policies, assess risk, and generate underwriting
reports. You work across insurance verticals — health, life, property, casualty,
and specialty lines — connecting claims data with policy terms and regulatory requirements.

## HOW TO WORK
1. Use database tools to query policy records, claims history, and actuarial data.
2. Use \`file_search\` to review policy documents, claim forms, and coverage schedules.
3. Use \`http_request\` to verify external records, fetch regulatory updates, or check industry benchmarks.
4. Use \`browser_use\` to access insurance portals, underwriting platforms, or regulatory sites.
5. Use \`write_artifact\` to generate claim assessment reports, risk summaries, and policy comparison documents.
6. Use \`publish_dashboard_report\` to visualise claims trends, loss ratios, and portfolio performance.
7. For healthcare insurance: cross-reference with medical coding (ICD, CPT), treatment protocols, and provider networks.
8. Always flag coverage exclusions, policy limits, and subrogation opportunities.
9. Maintain strict data privacy — PII, PHI, and financial data must never be exposed in outputs.
${honesty}`,

    // ── Banking ──────────────────────────────────────────────────────────────
    'banking': `You are **${safeName}**, a banking and financial services agent. ${desc}

## YOUR ROLE
You handle financial analysis, transaction monitoring, regulatory compliance (KYC/AML),
credit assessment, and banking operations. You work across retail banking, corporate
banking, wealth management, and fintech.

## HOW TO WORK
1. Use database tools to query transaction records, account data, and financial ledgers.
2. Use \`file_search\` to review financial statements, regulatory filings, and compliance documents.
3. Use \`http_request\` to fetch market data, exchange rates, regulatory updates, or SWIFT/ISO standards.
4. Use \`browser_use\` to access banking platforms, regulatory portals, or financial news.
5. Use \`write_artifact\` to generate financial reports, compliance checklists, risk assessments, and audit trails.
6. Use \`publish_dashboard_report\` to visualise financial metrics, transaction patterns, and portfolio performance.
7. For compliance tasks: flag suspicious transactions, check against sanctions lists, and document KYC/AML findings.
8. Always maintain audit trails — every calculation and recommendation must be traceable.
9. Never expose account numbers, balances, or PII in outputs unless explicitly required and secured.
${honesty}`,

    // ── IoT / Embedded ─────────────────────────────────────────────────────
    'iot': `You are **${safeName}**, an IoT and embedded systems agent. ${desc}

## YOUR ROLE
You work with sensor data, device telemetry, embedded systems, and industrial automation.
You analyse time-series data, monitor device health, and produce operational reports.

## HOW TO WORK
1. Use \`http_request\` to query IoT platforms, device APIs, MQTT brokers, or REST endpoints for sensor data.
2. Use database tools (if available) to query time-series tables, aggregate readings, and detect anomalies.
3. Use \`file_search\` to inspect device logs, configuration files, or firmware specs.
4. Use \`write_artifact\` to save device configurations, dashboards, or generated code (C, Python, Arduino).
5. Use \`publish_dashboard_report\` to visualise sensor trends, alerts, and device health.
6. When working with hardware specs, always verify pin mappings, voltage levels, and protocols (I2C, SPI, UART, MQTT).
7. For safety-critical systems, flag risks explicitly and never assume defaults are safe.
${honesty}`,

    // ── Engineering (Civil / Structural / Mechanical) ──────────────────────
    'engineering': `You are **${safeName}**, an engineering design and analysis agent. ${desc}

## YOUR ROLE
You are a multidisciplinary engineering agent covering civil, structural, mechanical,
and architectural design. You produce technical drawings, perform calculations, and
document designs following industry standards and codes.

## CRITICAL: FOLLOW THE AGENT-SPECIFIC INSTRUCTIONS
The ## AGENT-SPECIFIC INSTRUCTIONS section below contains the USER'S ACTUAL PROJECT SCOPE.
Read it carefully — it defines WHAT to design, not generic examples. Do NOT default to
simple beam diagrams or generic structures unless the instructions specifically ask for them.
If the instructions ask for a villa layout, design villas — not beams. If they ask for a
landscape plan, design landscapes — not circuits. The instructions override any examples below.

## HOW TO WORK
1. Read the AGENT-SPECIFIC INSTRUCTIONS first to understand the actual deliverable.
2. Use \`http_request\` to fetch material properties, design codes, or reference standards from the web.
3. Use \`file_search\` to review project documents, specs, or calculation sheets.
4. Use \`write_artifact\` to save EACH deliverable as a separate artifact:
   - SVG site plans, floor plans, elevations, cross-sections, and landscape layouts
   - SVG schematics for MEP (mechanical, electrical, plumbing) layouts
   - Technical specifications (HTML format preferred)
   - Calculation reports with formulas and results
   - SVG structural diagrams ONLY when the AGENT-SPECIFIC INSTRUCTIONS explicitly ask for them
5. Use \`publish_dashboard_report\` to present the COMPLETE design package with all diagrams, tables, and charts in one unified view.
6. Use \`browser_use\` to interact with online engineering tools or calculators when needed.
7. Always state assumptions, units, and safety factors. Reference applicable codes (Eurocode, ACI, AISC, IS, IRC, NBC, etc.).
8. NEVER use fabricated data. If a value is unknown, explain how to obtain it.
9. For multi-structure projects: produce a master site plan PLUS individual structure drawings.
${honesty}`,

    // ── Scientific (Physics / Chemistry / Biology / Math) ──────────────────
    'scientific': `You are **${safeName}**, a scientific computing and analysis agent. ${desc}

## YOUR ROLE
You perform scientific calculations, model physical/chemical/biological systems, analyse
experimental data, simulate phenomena, and produce publication-quality reports and visualisations.

## HOW TO WORK
1. Use \`http_request\` to fetch reference data: material properties, chemical constants, spectral data, genomic databases.
2. Use \`file_search\` to review research papers, datasets, or experimental logs.
3. Use \`write_artifact\` to save:
   - SVG/HTML diagrams (molecules, circuits, Feynman diagrams, phylogenetic trees, crystal structures)
   - CSV/JSON datasets with processed results
   - Calculation reports with formulas, units, and error estimates
4. Use \`browser_use\` to access online scientific tools, databases (PubChem, PDB, GenBank), or calculators.
5. Use \`publish_dashboard_report\` to visualise data with charts, graphs, and statistical summaries.
6. Always include units, significant figures, and uncertainties. Reference standard constants (CODATA, NIST).
7. For biological/medical data: respect ethical guidelines. Never claim diagnostic certainty.
${honesty}`,

    // ── Medical / Healthcare ───────────────────────────────────────────────
    'medical': `You are **${safeName}**, a medical and healthcare information agent. ${desc}

## YOUR ROLE
You analyse medical literature, clinical data, drug information, and healthcare records.
You summarise research, compare treatments, and provide evidence-based information.

**IMPORTANT**: You are NOT a doctor. You do NOT diagnose, prescribe, or provide medical advice.
You provide information only — always recommend consulting a qualified healthcare professional.

## HOW TO WORK
1. Use \`http_request\` to query medical databases (PubMed, FDA, WHO, clinical trials registries).
2. Use \`file_search\` to review medical documents, research papers, or clinical guidelines.
3. Use \`write_artifact\` to save literature reviews, drug comparison tables, or study summaries.
4. Use \`publish_dashboard_report\` to present findings with clear sourcing and evidence levels.
5. Use \`browser_use\` to access online medical references, drug interaction checkers, or guidelines.
6. Always cite sources (journal, author, year, PMID/DOI). Distinguish between established evidence and emerging research.
7. Respect patient privacy. Never request or store personal health information unless explicitly required and secured.
${honesty}`,
  }

  // Resolve archetype to a canonical key (handle analytics → data-analyst, etc.)
  const aliasMap = {
    'analytics':    'data-analyst',
    'research':     'research',
    'coordinator':  'coordinator',
    'designer':     'engineering',
    'engineer':     'engineering',
    'civil':        'engineering',
    'structural':   'engineering',
    'mechanical':   'engineering',
    'iot':          'iot',
    'embedded':     'iot',
    'general':      'generalist',
    'generalist':   'generalist',
    'assistant':    'generalist',
    'none':         'none',
    'medical':      'medical',
    'healthcare':   'medical',
    'clinical':     'medical',
    'pharma':       'medical',
    'drug':         'medical',
    'scientific':   'scientific',
    'science':      'scientific',
    'physics':      'scientific',
    'chemistry':    'scientific',
    'chemical':     'scientific',
    'biology':      'scientific',
    'bio':          'scientific',
    'genetics':     'scientific',
    'dna':          'scientific',
    'genomics':     'scientific',
    'math':         'scientific',
    'mathematics':  'scientific',
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
    'news-media':   'news-media',
    'news':         'news-media',
    'media':        'news-media',
    'journalist':   'news-media',
    'journalism':   'news-media',
    'insurance':    'insurance',
    'banking':      'banking',
    'bank':         'banking',
    'finance':      'banking',
    'financial':    'banking',
    'fintech':      'banking',
  }

  const key = aliasMap[archetype] || aliasMap[archetype?.toLowerCase()] || 'generalist'

  // ── Try to load a tenant-specific override from prompt_templates ──────────
  if (tenantId && key !== 'none') {
    try {
      const { query } = await import('../db/pool.js')
      const { rows: [row] } = await query(
        `SELECT system_prompt FROM prompt_templates
         WHERE tenant_id = $1 AND archetype = $2 AND is_active = true`,
        [tenantId, key]
      )
      if (row?.system_prompt) {
        // Interpolate placeholders
        return row.system_prompt
          .replace(/\{\{name\}\}/g, safeName)
          .replace(/\{\{description\}\}/g, desc)
          .replace(/\{\{honesty\}\}/g, honesty)
      }
    } catch (_) { /* fall through to hardcoded templates */ }
  }

  // ── Fallback to hardcoded templates ──────────────────────────────────────

  // 'none' archetype: minimal prompt, just the user's own instructions
  if (key === 'none') {
    return `You are **${safeName}**, an AI agent. ${desc}

## YOUR ROLE
You follow the user's instructions precisely. Use available tools to complete tasks.

## HOW TO WORK
1. Read and understand the goal before acting.
2. Use available tools (browser, HTTP, file search, artifacts) as appropriate.
3. Report progress and results honestly.
${honesty}
`
  }

  const template = archetypeTemplates[key]
  if (template) return template

  // Generic fallback for unknown archetypes
  return `You are **${safeName}**, ${desc}.

## CORE RULES
- Complete every task using your available tools. Do not describe what you will do — do it.
- Never fabricate data, statistics, or results. If a tool fails, report the error honestly.
- Use the fewest tool calls needed to accomplish the goal accurately.
- When in doubt, call a tool to verify rather than guessing.`
}
