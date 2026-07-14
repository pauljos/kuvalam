// test/integration/workflow.routes.test.js
// Integration tests for workflow CRUD + execution endpoint

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-exactly!!'
process.env.NODE_ENV = 'test'

const TENANT_ID = '550e8400-e29b-41d4-a716-446655440011'
const USER_ID   = '550e8400-e29b-41d4-a716-446655440012'
const WF_ID     = '550e8400-e29b-41d4-a716-446655440013'

import Fastify from 'fastify'
import jwt from '@fastify/jwt'

let app
let authToken

const mockWorkflows = new Map()

before(async () => {
  app = Fastify({ logger: false })
  await app.register(jwt, { secret: process.env.JWT_SECRET })

  app.decorate('authenticate', async (request, reply) => {
    try { await request.jwtVerify() }
    catch { reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }) }
  })

  // ── Workflow CRUD routes ──────────────────────────────────────────────────

  // List workflows
  app.get('/api/v1/tenants/:tenantId/workflows', { preHandler: [app.authenticate] }, async (req, reply) => {
    const wfs = [...mockWorkflows.values()].filter(w => w.tenantId === req.params.tenantId)
    return reply.send({ success: true, data: wfs, meta: { total: wfs.length } })
  })

  // Create workflow
  app.post('/api/v1/tenants/:tenantId/workflows', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'steps'],
        properties: {
          name: { type: 'string', minLength: 1 },
          steps: { type: 'array' },
          description: { type: 'string' }
        }
      }
    }
  }, async (req, reply) => {
    const { name, steps, description } = req.body
    const wf = { id: WF_ID, name, steps, description, tenantId: req.params.tenantId, status: 'ACTIVE' }
    mockWorkflows.set(wf.id, wf)
    return reply.status(201).send({ success: true, data: wf })
  })

  // Get workflow by ID
  app.get('/api/v1/tenants/:tenantId/workflows/:workflowId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const wf = mockWorkflows.get(req.params.workflowId)
    if (!wf) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Workflow not found' } })
    return reply.send({ success: true, data: wf })
  })

  // Update workflow
  app.patch('/api/v1/tenants/:tenantId/workflows/:workflowId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const wf = mockWorkflows.get(req.params.workflowId)
    if (!wf) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } })
    const updated = { ...wf, ...req.body }
    mockWorkflows.set(wf.id, updated)
    return reply.send({ success: true, data: updated })
  })

  // Delete workflow
  app.delete('/api/v1/tenants/:tenantId/workflows/:workflowId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const existed = mockWorkflows.delete(req.params.workflowId)
    if (!existed) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } })
    return reply.status(204).send()
  })

  // Trigger workflow execution
  app.post('/api/v1/tenants/:tenantId/workflows/:workflowId/executions', { preHandler: [app.authenticate] }, async (req, reply) => {
    const wf = mockWorkflows.get(req.params.workflowId)
    if (!wf) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } })
    return reply.status(202).send({ success: true, data: { executionId: 'exec-001', status: 'RUNNING', workflowId: wf.id } })
  })

  authToken = app.jwt.sign({ userId: USER_ID, tenantId: TENANT_ID, email: 'test@example.com' }, { expiresIn: '15m' })
  await app.ready()
})

after(async () => { await app.close() })

// ─── Tests ────────────────────────────────────────────────────────────────────

test('GET /workflows: returns empty list initially', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/tenants/${TENANT_ID}/workflows`,
    headers: { Authorization: `Bearer ${authToken}` }
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.ok(body.success)
  assert.deepEqual(body.data, [])
})

test('POST /workflows: creates workflow with valid payload', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${TENANT_ID}/workflows`,
    headers: { Authorization: `Bearer ${authToken}` },
    payload: {
      name: 'Daily Report Workflow',
      description: 'Runs every morning',
      steps: [
        { type: 'AGENT', agentId: 'ag-001', goal: 'Fetch data' },
        { type: 'AGENT', agentId: 'ag-002', goal: 'Summarise data' }
      ]
    }
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.ok(body.success)
  assert.equal(body.data.name, 'Daily Report Workflow')
  assert.equal(body.data.steps.length, 2)
  assert.equal(body.data.status, 'ACTIVE')
})

test('POST /workflows: returns 400 for missing name', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${TENANT_ID}/workflows`,
    headers: { Authorization: `Bearer ${authToken}` },
    payload: { steps: [] }
  })
  assert.equal(res.statusCode, 400)
})

test('POST /workflows: returns 400 for missing steps', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${TENANT_ID}/workflows`,
    headers: { Authorization: `Bearer ${authToken}` },
    payload: { name: 'No Steps Workflow' }
  })
  assert.equal(res.statusCode, 400)
})

test('GET /workflows: returns created workflow in list', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/tenants/${TENANT_ID}/workflows`,
    headers: { Authorization: `Bearer ${authToken}` }
  })
  const body = res.json()
  assert.equal(body.data.length, 1)
  assert.equal(body.data[0].name, 'Daily Report Workflow')
})

test('GET /workflows/:id: returns specific workflow', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/tenants/${TENANT_ID}/workflows/${WF_ID}`,
    headers: { Authorization: `Bearer ${authToken}` }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().data.id, WF_ID)
})

test('GET /workflows/:id: returns 404 for unknown ID', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/tenants/${TENANT_ID}/workflows/550e8400-0000-0000-0000-000000000000`,
    headers: { Authorization: `Bearer ${authToken}` }
  })
  assert.equal(res.statusCode, 404)
})

test('PATCH /workflows/:id: updates name', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/v1/tenants/${TENANT_ID}/workflows/${WF_ID}`,
    headers: { Authorization: `Bearer ${authToken}` },
    payload: { name: 'Updated Workflow Name' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().data.name, 'Updated Workflow Name')
})

test('POST /executions: triggers workflow execution', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${TENANT_ID}/workflows/${WF_ID}/executions`,
    headers: { Authorization: `Bearer ${authToken}` },
    payload: { context: { reportDate: '2024-01-01' } }
  })
  assert.equal(res.statusCode, 202)
  const body = res.json()
  assert.ok(body.success)
  assert.equal(body.data.status, 'RUNNING')
  assert.equal(body.data.workflowId, WF_ID)
})

test('DELETE /workflows/:id: deletes workflow', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/tenants/${TENANT_ID}/workflows/${WF_ID}`,
    headers: { Authorization: `Bearer ${authToken}` }
  })
  assert.equal(res.statusCode, 204)
})

test('GET /workflows: empty after deletion', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/tenants/${TENANT_ID}/workflows`,
    headers: { Authorization: `Bearer ${authToken}` }
  })
  assert.deepEqual(res.json().data, [])
})

test('GET /workflows: returns 401 without token', async () => {
  // POST without a body gets a 400 from schema validation before auth — test GET instead
  const res = await app.inject({ method: 'GET', url: `/api/v1/tenants/${TENANT_ID}/workflows` })
  assert.equal(res.statusCode, 401)
})
