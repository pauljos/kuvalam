// test/integration/auth.routes.test.js
// Integration tests for /api/v1/auth/* endpoints using Fastify inject
// These run against a real Fastify instance (no DB dependency)

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// ─── Set env vars before any imports ────────────────────────────────────────
process.env.JWT_SECRET = 'test-jwt-secret-min-32-chars-exactly!!'
process.env.NODE_ENV = 'test'

import Fastify from 'fastify'
import jwt from '@fastify/jwt'

let app
let authToken

before(async () => {
  app = Fastify({ logger: false })

  await app.register(jwt, {
    secret: process.env.JWT_SECRET
  })

  // Add authenticate decorator (mirrors real app)
  app.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify()
    } catch (err) {
      reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } })
    }
  })

  // Minimal login route that mimics the real handler
  app.post('/api/v1/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string' },
          password: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { email, password } = request.body
    if (email === 'test@example.com' && password === 'password123') {
      const accessToken = app.jwt.sign(
        { userId: 'usr-001', tenantId: 'ten-001', email },
        { expiresIn: '15m' }
      )
      // Set httpOnly cookie manually (bypassing @fastify/cookie plugin)
      reply.header('Set-Cookie',
        `kuvalam_token=${accessToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900`
      )
      return reply.send({
        success: true,
        data: { accessToken, refreshToken: 'rt-test', user: { id: 'usr-001', email }, tenants: [] }
      })
    }
    return reply.status(401).send({
      success: false,
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' }
    })
  })

  app.post('/api/v1/auth/logout', async (request, reply) => {
    reply.header('Set-Cookie', 'kuvalam_token=; Path=/; HttpOnly; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT')
    return reply.send({ success: true })
  })

  // Protected route
  app.get('/api/v1/me', { preHandler: [app.authenticate] }, async (request) => {
    return { success: true, data: request.user }
  })

  await app.ready()
})

after(async () => { await app.close() })

// ─── Tests ────────────────────────────────────────────────────────────────────

test('POST /auth/login: returns 200 with valid credentials', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'test@example.com', password: 'password123' }
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.ok(body.success)
  assert.ok(body.data.accessToken)
  assert.ok(body.data.refreshToken)
})

test('POST /auth/login: sets httpOnly kuvalam_token cookie', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'test@example.com', password: 'password123' }
  })
  const setCookie = res.headers['set-cookie']
  assert.ok(setCookie, 'Expected Set-Cookie header')
  const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : setCookie
  assert.ok(cookieStr.includes('kuvalam_token'), 'Cookie name should be kuvalam_token')
  assert.ok(cookieStr.toLowerCase().includes('httponly'), 'Cookie must be httpOnly')
})

test('POST /auth/login: returns 401 with wrong password', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'test@example.com', password: 'wrongpassword' }
  })
  assert.equal(res.statusCode, 401)
  const body = res.json()
  assert.ok(!body.success)
  assert.equal(body.error.code, 'INVALID_CREDENTIALS')
})

test('POST /auth/login: returns 400 for missing email', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'password123' }
  })
  assert.equal(res.statusCode, 400)
})

test('POST /auth/login: returns 400 for missing password', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'test@example.com' }
  })
  assert.equal(res.statusCode, 400)
})

test('POST /auth/login: returns 400 for empty body', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {}
  })
  assert.equal(res.statusCode, 400)
})

test('GET /me: returns 401 without token', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/me' })
  assert.equal(res.statusCode, 401)
})

test('GET /me: returns 200 with valid JWT in Authorization header', async () => {
  const token = app.jwt.sign({ userId: 'usr-001', email: 'test@example.com' }, { expiresIn: '15m' })
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { Authorization: `Bearer ${token}` }
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.ok(body.success)
  assert.equal(body.data.email, 'test@example.com')
})

test('GET /me: returns 401 with a tampered/invalid token', async () => {
  // Tamper with a valid token by appending garbage to the signature
  const token = app.jwt.sign({ userId: 'usr-001', email: 'test@example.com' }, { expiresIn: '15m' }) + 'tampered'
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/me',
    headers: { Authorization: `Bearer ${token}` }
  })
  assert.equal(res.statusCode, 401)
})

test('POST /auth/logout: clears the cookie', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' })
  assert.equal(res.statusCode, 200)
  const setCookie = res.headers['set-cookie']
  assert.ok(setCookie, 'Should send a Set-Cookie header on logout')
  const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : setCookie
  assert.ok(
    cookieStr.toLowerCase().includes('max-age=0') ||
    cookieStr.toLowerCase().includes('expires='),
    'Cookie should be cleared/expired on logout'
  )
})
