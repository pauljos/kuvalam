// apps/api/src/services/agent.service.js
import { query, transaction } from '../db/pool.js'
import { auditLog } from '../utils/audit.js'
import { AppError } from '../utils/errors.js'

const PLAN_LIMITS = {
  TRIAL: 5, PRO: 25, ENTERPRISE: Infinity
}

export async function createAgent({ tenantId, data, userId }) {
  // Plan limit check
  const { rows: [limitRow] } = await query(
    `SELECT COUNT(a.*) as count, t.plan FROM agents a
     JOIN tenants t ON t.id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.status != 'ARCHIVED'
     GROUP BY t.plan`,
    [tenantId]
  )
  const plan = limitRow?.plan || 'TRIAL'
  const limit = PLAN_LIMITS[plan]
  if (parseInt(limitRow?.count || 0) >= limit) {
    throw new AppError('AGENT_LIMIT_REACHED', `Your ${plan} plan allows max ${limit} agents`, 402)
  }

  const { rows: [agent] } = await query(
    `INSERT INTO agents (tenant_id, name, description, archetype, autonomy_level, llm_provider, llm_model, system_prompt, confidence_threshold, max_actions_per_run, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [tenantId, data.name, data.description, data.archetype, data.autonomyLevel || 'SUPERVISED',
     data.llmProvider || 'openai', data.llmModel || 'gpt-4o', data.systemPrompt,
     data.confidenceThreshold || 0.75, data.maxActionsPerRun || 20, userId]
  )

  await auditLog({ eventType: 'agent.created', tenantId, actorId: userId, actorType: 'USER', resourceType: 'Agent', resourceId: agent.id, action: 'CREATE', afterState: { name: data.name } })
  return agent
}

export async function getAgent(tenantId, agentId) {
  const { rows: [agent] } = await query(
    `SELECT a.*,
      (SELECT json_agg(row_to_json(s)) FROM agent_skills s WHERE s.agent_id = a.id AND s.is_enabled = true) as skills,
      (SELECT json_agg(row_to_json(r) ORDER BY r.priority) FROM agent_rules r WHERE r.agent_id = a.id AND r.is_active = true) as rules,
      (SELECT json_agg(kb.id) FROM agent_knowledge_bases akb JOIN knowledge_bases kb ON kb.id = akb.knowledge_base_id WHERE akb.agent_id = a.id) as knowledge_base_ids
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

  if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status) }

  const offset = (page - 1) * pageSize
  const { rows } = await query(
    `SELECT * FROM agents WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  )
  const { rows: [{ count }] } = await query(`SELECT COUNT(*) FROM agents WHERE ${conditions.join(' AND ')}`, params)

  return { agents: rows, pagination: { page, pageSize, total: parseInt(count), totalPages: Math.ceil(parseInt(count) / pageSize) } }
}

export async function updateAgent(tenantId, agentId, updates, userId) {
  const allowed = ['name','description','system_prompt','autonomy_level','llm_provider','llm_model','confidence_threshold','max_actions_per_run']
  const fields = Object.keys(updates).filter(k => allowed.includes(k) || allowed.includes(toSnakeCase(k)))
  if (fields.length === 0) throw new AppError('NO_VALID_FIELDS', 'No valid fields to update', 400)

  // Map camelCase to snake_case
  const mapped = {}
  for (const k of fields) mapped[toSnakeCase(k)] = updates[k]

  const setClause = Object.keys(mapped).map((f, i) => `${f} = $${i + 3}`).join(', ')
  const { rows: [agent] } = await query(
    `UPDATE agents SET ${setClause} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [agentId, tenantId, ...Object.values(mapped)]
  )
  if (!agent) throw new AppError('AGENT_NOT_FOUND', 'Agent not found', 404)

  await auditLog({ eventType: 'agent.updated', tenantId, actorId: userId, actorType: 'USER', resourceType: 'Agent', resourceId: agentId, action: 'UPDATE' })
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
