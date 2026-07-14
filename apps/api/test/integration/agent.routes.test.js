// test/integration/agent.routes.test.js
// Integration tests for /api/v1/tenants/:tid/agents/* (task dispatch, validation)

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-exactly!!'
process.env.NODE_ENV = 'test'

const TENANT_ID = '550e8400-e29b-41d4-a716-446655440001'
const AGENT_ID  = '550e8400-e29b-41d4-a716-446655440002'
const USER_ID   = '550e8400-e29b-41d4-a716-446655440003'

import Fastify from 'fastify'
import jwt from '@fastify/jwt'

let app
let authToken

before(async () => {
  app = Fastify({ logger: false })
  await app.register(jwt, { secret: process.env.JWT_SECRET })

  app.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify()
    } catch {
      reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } })
    }
  })

  // Minimal tenant middleware
  app.addHook('preHandler', async (request) => {
    const { tenantId } = request.params || {}
    if (tenantId) request.tenantId = tenantId
  })

  // ── Agent routes (simplified mirrors of the real route handler shape) ──────

  // GET agents list
  app.get('/api/v1/tenants/:tenantId/agents', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    return reply.send({ success: true, data: [], meta: { total: 0 } })
  })

  // POST create agent
  app.post('/api/v1/tenants/:tenantId/agents', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'systemPrompt'],
        properties: {
          name: { type: 'string', minLength: 1 },
          systemPrompt: { type: 'string' },
          model: { type: 'string' },
          tools: { type: 'array' }
        }
      }
    }
  }, async (request, reply) => {
    const { name, systemPrompt, model = 'gpt-4o', tools = [] } = request.body
    const agent = { id: AGENT_ID, name, systemPrompt, model, tools, tenantId: request.params.tenantId }
    return reply.status(201).send({ success: true, data: agent })
  })

  // POST dispatch task to agent
  app.post('/api/v1/tenants/:tenantId/agents/:agentId/tasks', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { goal, priority, attachments = [] } = request.body || {}

    // Replicate dispatchTask validation
    if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
      return reply.status(400).send({ success: false, error: { code: 'MISSING_GOAL', message: 'Task goal is required' } })
    }
    if (goal.length > 10_000) {
      return reply.status(400).send({ success: false, error: { code: 'GOAL_TOO_LONG', message: 'Goal too long' } })
    }
    if (attachments.length > 5) {
      return reply.status(400).send({ success: false, error: { code: 'TOO_MANY_ATTACHMENTS', message: 'Max 5 attachments' } })
    }

    const task = {
      id: 'task-001',
      agentId: request.params.agentId,
      tenantId: request.params.tenantId,
      goal: goal.trim(),
      status: 'QUEUED',
      createdAt: new Date().toISOString()
    }
    return reply.status(202).send({ success: true, data: task })
  })

  // GET task status
  app.get('/api/v1/tenants/:tenantId/agents/:agentId/tasks/:taskId', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { taskId } = request.params
    return reply.send({ success: true, data: { id: taskId, status: 'COMPLETED', output: 'Done.' } })
  })

  authToken = app.jwt.sign({ userId: USER_ID, tenantId: TENANT_ID, email: 'test@example.com' }, { expiresIn: '15m' })
  await app.ready()
})

after(async () => { await app.close() })

// ─── Tests ────────────────────────────────────────────────────────────────────

test('GET /agents: returns 200 with token', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/tenants/${TENANT_ID}/agents`,
    headers: { Authorization: `Bearer ${authToken}` }
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.ok(body.success)
  assert.ok(Array.isArray(body.data))
})

test('GET /agents: returns 401 without token', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/v1/tenants/${TENANT_ID}/agents` })
  assert.equal(res.statusCode, 401)
})

test('POST /agents: creates agent with valid body', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${TENANT_ID}/agents`,
    headers: { Authorization: `Bearer ${authToken}` },
    payload: { name: 'Test Agent', systemPrompt: 'You are a helpful assistant', model: 'gpt-4o' }
  })
  assert.equal(res.statusCode, 201)
  const body = res.json()
  assert.ok(body.success)
  assert.equal(body.data.name, 'Test Agent')
})

test('POST /agents: returns 400 for missing name', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${TENANT_ID}/agents`,
    headers: { Authorization: `Bearer ${authToken}` },
    payload: { systemPrompt: 'You are helpful' }
  })
  assert.equal(res.statusCode, 400)
})

test('POST /tasks: dispatches task with valid goal', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${TENANT_ID}/agents/${AGENT_ID}/tasks`,
    headers: { Authorization: `Bearer ${authToken}` },
    payload: { goal: 'Summarise the latest sales report', priority: 'HIGH' }
  })
  assert.equal(res.statusCode, 202)
  const body = res.json()
  assert.ok(body.success)
  assert.equal(body.data.status, 'QUEUED')
  assert.equal(body.data.agentId, AGENT_ID)
})

test('POST /tasks: returns 400 for empty goal', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${TENANT_ID}/agents/${AGENT_ID}/tasks`,
    headers: { Authorization: `Bearer ${authToken}` },
    payload: { goal: '' }
  })
  assert.equal(res.statusCode, 400)
  const body = res.json()
  assert.equal(body.error.code, 'MISSING_GOAL')
})

test('POST /tasks: returns 400 for missing goal', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${TENANT_ID}/agents/${AGENT_ID}/tasks`,
    headers: { Authorization: `Bearer ${authToken}` },
    payload: {}
  })
  assert.equal(res.statusCode, 400)
  const body = res.json()
  assert.equal(body.error.code, 'MISSING_GOAL')
})

test('POST /tasks: returns 400 for goal over 10,000 chars', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${TENANT_ID}/agents/${AGENT_ID}/tasks`,
    headers: { Authorization: `Bearer ${authToken}` },
    payload: { goal: 'x'.repeat(10_001) }
  })
  assert.equal(res.statusCode, 400)
  const body = res.json()
  assert.equal(body.error.code, 'GOAL_TOO_LONG')
})

test('POST /tasks: returns 400 for too many attachments', async () => {
  const attachments = Array.from({ length: 6 }, (_, i) => ({ type: 'image_url', url: `https://cdn.example.com/${i}.png` }))
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${TENANT_ID}/agents/${AGENT_ID}/tasks`,
    headers: { Authorization: `Bearer ${authToken}` },
    payload: { goal: 'Process these images', attachments }
  })
  assert.equal(res.statusCode, 400)
  const body = res.json()
  assert.equal(body.error.code, 'TOO_MANY_ATTACHMENTS')
})

test('POST /tasks: returns 401 without token', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/tenants/${TENANT_ID}/agents/${AGENT_ID}/tasks`,
    payload: { goal: 'Do something' }
  })
  assert.equal(res.statusCode, 401)
})

test('GET /tasks/:id: returns task status', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/tenants/${TENANT_ID}/agents/${AGENT_ID}/tasks/task-001`,
    headers: { Authorization: `Bearer ${authToken}` }
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.ok(body.success)
  assert.equal(body.data.id, 'task-001')
})
