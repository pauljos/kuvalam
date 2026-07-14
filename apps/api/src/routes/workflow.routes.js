// apps/api/src/routes/workflow.routes.js
import * as workflowService from '../services/workflow.service.js'

export default async function workflowRoutes(fastify) {
  // Enforce authentication
  fastify.addHook('onRequest', fastify.authenticate)

  // Create workflow
  fastify.post('/tenants/:tenantId/workflows', async (req, reply) => {
    const { tenantId } = req.params
    const { name, description, trigger, steps, onFailure } = req.body
    const wf = await workflowService.createWorkflow(tenantId, {
      name, description, trigger, steps, onFailure, userId: req.user.id
    })
    return { data: wf }
  })

  // List workflows
  fastify.get('/tenants/:tenantId/workflows', async (req, reply) => {
    const { tenantId } = req.params
    const workflows = await workflowService.listWorkflows(tenantId)
    return { data: { workflows } }
  })

  // List executions
  fastify.get('/tenants/:tenantId/workflows/executions', async (req, reply) => {
    const { tenantId } = req.params
    const executions = await workflowService.listExecutions(tenantId)
    return { data: { executions } }
  })

  // Get workflow details
  fastify.get('/tenants/:tenantId/workflows/:id', async (req, reply) => {
    const { tenantId, id } = req.params
    const wf = await workflowService.getWorkflow(tenantId, id)
    return { data: wf }
  })

  // Update workflow
  fastify.patch('/tenants/:tenantId/workflows/:id', async (req, reply) => {
    const { tenantId, id } = req.params
    const updated = await workflowService.updateWorkflow(tenantId, id, {
      ...req.body, userId: req.user.id
    })
    return { data: updated }
  })

  // Start execution
  fastify.post('/tenants/:tenantId/workflows/:id/execute', async (req, reply) => {
    const { tenantId, id } = req.params
    const { context } = req.body
    const exec = await workflowService.startWorkflowExecution(tenantId, id, { context })
    return { data: exec }
  })

  // Duplicate workflow
  fastify.post('/tenants/:tenantId/workflows/:id/duplicate', async (req, reply) => {
    const { tenantId, id } = req.params
    const src = await workflowService.getWorkflow(tenantId, id)
    const clone = await workflowService.createWorkflow(tenantId, {
      name: `${src.name} (copy)`,
      description: src.description,
      trigger: src.trigger,
      steps: src.steps,
      onFailure: src.on_failure,
      userId: req.user.id || req.user.sub,
    })
    return reply.status(201).send({ data: clone })
  })

  // Get execution details & step trace
  fastify.get('/tenants/:tenantId/workflows/executions/:execId', async (req, reply) => {
    const { tenantId, execId } = req.params
    const trace = await workflowService.getExecution(tenantId, execId)
    return { data: trace }
  })

  // Resume paused workflow (approve/reject HITL)
  fastify.post('/tenants/:tenantId/workflows/executions/:execId/resume', async (req, reply) => {
    const { tenantId, execId } = req.params
    const { approved, notes, modifiedInput } = req.body
    const status = await workflowService.resumeWorkflowExecution(tenantId, execId, {
      approved, notes, modifiedInput
    })
    return { data: status }
  })

  // Dry-run a single step — used by the "Test step" button in the canvas
  // builder. Body: { step, context? }. Response: { ok, output|error, durationMs }.
  // AGENT / CREW / LOOP / APPROVAL types are rejected as unsupported for dry-run.
  fastify.post('/tenants/:tenantId/workflows/dry-run-step', async (req, reply) => {
    const { tenantId } = req.params
    const { step, context } = req.body || {}
    const result = await workflowService.dryRunStep(tenantId, step, context || {})
    return { data: result }
  })
}
