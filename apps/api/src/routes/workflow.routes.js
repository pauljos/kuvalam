// apps/api/src/routes/workflow.routes.js
import * as workflowService from '../services/workflow.service.js'
import { complete } from '../services/llm.service.js'
import { errorResponse } from '../utils/errors.js'

export default async function workflowRoutes(fastify) {
  // Enforce authentication
  fastify.addHook('onRequest', fastify.authenticate)

  // Create workflow
  fastify.post('/tenants/:tenantId/workflows', async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { name, description, trigger, steps, onFailure } = req.body
      const wf = await workflowService.createWorkflow(tenantId, {
        name, description, trigger, steps, onFailure, userId: req.user.sub
      })
      return reply.status(201).send({ data: wf })
    } catch (err) { return errorResponse(reply, err) }
  })

  // List workflows
  fastify.get('/tenants/:tenantId/workflows', async (req, reply) => {
    try {
      const { tenantId } = req.params
      const workflows = await workflowService.listWorkflows(tenantId)
      return { data: { workflows } }
    } catch (err) { return errorResponse(reply, err) }
  })

  // List executions
  fastify.get('/tenants/:tenantId/workflows/executions', async (req, reply) => {
    try {
      const { tenantId } = req.params
      const executions = await workflowService.listExecutions(tenantId)
      return { data: { executions } }
    } catch (err) { return errorResponse(reply, err) }
  })

  // Get workflow details
  fastify.get('/tenants/:tenantId/workflows/:id', async (req, reply) => {
    try {
      const { tenantId, id } = req.params
      const wf = await workflowService.getWorkflow(tenantId, id)
      return { data: wf }
    } catch (err) { return errorResponse(reply, err) }
  })

  // Update workflow
  fastify.patch('/tenants/:tenantId/workflows/:id', async (req, reply) => {
    try {
      const { tenantId, id } = req.params
      const updated = await workflowService.updateWorkflow(tenantId, id, {
        ...req.body, userId: req.user.sub
      })
      return { data: updated }
    } catch (err) { return errorResponse(reply, err) }
  })

  // Start execution
  fastify.post('/tenants/:tenantId/workflows/:id/execute', async (req, reply) => {
    try {
      const { tenantId, id } = req.params
      const { context } = req.body
      const exec = await workflowService.startWorkflowExecution(tenantId, id, { context })
      return { data: exec }
    } catch (err) { return errorResponse(reply, err) }
  })

  // Duplicate workflow
  fastify.post('/tenants/:tenantId/workflows/:id/duplicate', async (req, reply) => {
    try {
      const { tenantId, id } = req.params
      const src = await workflowService.getWorkflow(tenantId, id)
      const clone = await workflowService.createWorkflow(tenantId, {
        name: `${src.name} (copy)`,
        description: src.description,
        trigger: src.trigger,
        steps: src.steps,
        onFailure: src.on_failure,
        userId: req.user.sub,
      })
      return reply.status(201).send({ data: clone })
    } catch (err) { return errorResponse(reply, err) }
  })

  // Delete workflow
  fastify.delete('/tenants/:tenantId/workflows/:id', async (req, reply) => {
    try {
      const { tenantId, id } = req.params
      const deleted = await workflowService.deleteWorkflow(tenantId, id)
      if (!deleted) return reply.status(404).send({ error: { code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found' } })
      return reply.status(200).send({ data: { deleted: true } })
    } catch (err) { return errorResponse(reply, err) }
  })

  // Get execution details & step trace
  fastify.get('/tenants/:tenantId/workflows/executions/:execId', async (req, reply) => {
    try {
      const { tenantId, execId } = req.params
      const trace = await workflowService.getExecution(tenantId, execId)
      return { data: trace }
    } catch (err) { return errorResponse(reply, err) }
  })

  // Resume paused workflow (approve/reject HITL)
  fastify.post('/tenants/:tenantId/workflows/executions/:execId/resume', async (req, reply) => {
    try {
      const { tenantId, execId } = req.params
      const { approved, notes, modifiedInput } = req.body
      const status = await workflowService.resumeWorkflowExecution(tenantId, execId, {
        approved, notes, modifiedInput
      })
      return { data: status }
    } catch (err) { return errorResponse(reply, err) }
  })

  // Dry-run a single step — used by the "Test step" button in the canvas
  // builder. Body: { step, context? }. Response: { ok, output|error, durationMs }.
  // AGENT / CREW / LOOP / APPROVAL types are rejected as unsupported for dry-run.
  fastify.post('/tenants/:tenantId/workflows/dry-run-step', async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { step, context } = req.body || {}
      const result = await workflowService.dryRunStep(tenantId, step, context || {})
      return { data: result }
    } catch (err) { return errorResponse(reply, err) }
  })

  // Generate workflow from natural-language prompt (AI template builder)
  // POST /tenants/:tenantId/workflows/generate
  // Body: { prompt: string }
  // Returns: { name, description, steps }
  fastify.post('/tenants/:tenantId/workflows/generate', async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { prompt } = req.body || {}

      if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
        return reply.status(400).send({ error: { code: 'INVALID_PROMPT', message: 'Prompt must be at least 10 characters.' } })
      }

      const systemPrompt = `You are a workflow builder for the Kuvalam agent platform. Given a user's description of an automation, generate a JSON object with:
- "name": A short, catchy title for this workflow (max 5 words)
- "description": A one-line summary of what it does
- "steps": An array of step objects representing a workflow DAG.

Available step types (each has: id, type, input, and optional _ui.position with {x,y} for canvas layout):
1. AGENT — Run an AI agent. input: { goal: "string" }
2. TOOL — Execute a connector tool. input: { tool: "tool_name", args: {...} }
3. HTTP — Make an HTTP request. input: { method: "GET|POST|PUT|DELETE", url: "https://...", headers?: {...}, body?: "..." }
4. NOTIFY — Send notification. input: { provider: "slack|gmail|discord|sendgrid|twilio", channel: "...", message: "...", subject?: "..." }
5. CONDITION — Branch on context. Has a "routes" field: [{ when: "expression", goto: "step_id" }, { goto: "step_id" }] — the last route is the default (no when).
6. APPROVAL — Human-in-the-loop. input: {} and optional "goto" field for the next step after approval.
7. TRANSFORM — Transform data. input: { template: { fieldName: "{{expression}}" } }
8. PARALLEL — Run tasks in parallel. input: { tasks: [{ id, type, input }] } — each task has the same shape as a step.
9. WAIT — Pause. input: { seconds: number }
10. LOOP — Loop over items. input: { over: "{{arrayExpression}}", as: "item", steps: [step...] }
11. CREW — Multi-agent crew. input: { agents: [{ name: "role", goal: "..." }], strategy: "sequential|parallel" }
12. DB — Database query. input: { sql: "SQL query", connectionId: "optional" }
13. WEBHOOK — Incoming webhook trigger. This is special — it's the starting node for event-driven workflows.

You can reference outputs from previous steps using {{stepId.fieldName}} syntax.

Available connector tools (use these for TOOL steps): slack__post_message, gmail__send_email, discord__send_message, twilio__send_sms, sendgrid__send_email, jira__create_issue, jira__search_issues, github__get_repo, github__create_issue, github__list_prs, mqtt__subscribe, mqtt__publish, thingsboard__telemetry, aws__s3_list, aws__cloudwatch_metrics, aws__s3_upload, prometheus__query_range, prometheus__query, datadog__metrics_query, datadog__list_monitors, elasticsearch__search, snowflake__query, k8s__get, k8s__list, terraform__plan, terraform__apply, docker__ps, docker__run, docker__restart, ssh__exec, service_now__get_incident, service_now__create_incident, zendesk__list_tickets, zendesk__create_ticket, salesforce__query, salesforce__create_record, hubspot__get_contacts, hubspot__create_contact, stripe__list_charges, stripe__list_customers, stripe__refund, quickbooks__list_accounts, quickbooks__list_invoices, confluence__create_page, confluence__search, db__query, http_request__, http_download__, publish_dashboard_report__.

Rules:
- Every step needs an "id" (short kebab or snake_case string) and a "type".
- Include _ui.position for each step to create a readable left-to-right layout (spaced ~300px apart horizontally, ~120px vertically for branches).
- Steps should form a connected DAG — use CONDITION routes for branching.
- Use {{previousStepId}} to reference earlier outputs.
- Keep the workflow to 3-7 steps. Be practical, not over-engineered.
- Return ONLY valid JSON — no markdown, no backticks, no explanation.`

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Create a workflow that: ${prompt.trim()}` },
      ]

      // Get tenant LLM config — use system LLM if configured
      const { query: dbQuery } = await import('../db/pool.js')
      const { rows } = await dbQuery(
        'SELECT llm_config FROM tenants WHERE id = $1',
        [tenantId]
      )
      const llmConfig = rows?.[0]?.llm_config || {}

      const result = await complete({
        tenantId,
        agentId: 'workflow-generator',
        messages,
        llmConfig,
        useSystemLlm: true,
        temperature: 0.2,
        goal: `Generate workflow from prompt: ${prompt.trim().slice(0, 80)}`,
      })

      // Parse the LLM response as JSON
      const text = (result.content || '').trim()
      let parsed
      try {
        // Strip markdown code fences if present
        const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        parsed = JSON.parse(clean)
      } catch {
        return reply.status(422).send({
          error: { code: 'PARSE_ERROR', message: 'Failed to parse generated workflow. Please try rephrasing your prompt.', raw: text.slice(0, 500) }
        })
      }

      if (!parsed.steps || !Array.isArray(parsed.steps)) {
        return reply.status(422).send({
          error: { code: 'INVALID_STEPS', message: 'Generated workflow has no valid steps array.' }
        })
      }

      return {
        data: {
          name: parsed.name || 'Generated Workflow',
          description: parsed.description || `AI-generated workflow: ${prompt.trim().slice(0, 60)}…`,
          steps: parsed.steps,
        }
      }
    } catch (err) {
      if (err.message === 'LLM_RATE_LIMITED') {
        return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'LLM rate limit reached. Please try again in a moment.' } })
      }
      if (err.message === 'LLM_AUTH_ERROR') {
        return reply.status(400).send({ error: { code: 'LLM_NOT_CONFIGURED', message: 'No LLM configured for this tenant. Set up an API key in Settings.' } })
      }
      return errorResponse(reply, err)
    }
  })
}
