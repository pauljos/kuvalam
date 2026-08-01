// apps/api/src/routes/shared-memory.routes.js
// REST endpoints for tenant-wide shared memory.

import {
  listSharedMemory,
  upsertSharedMemory,
  deleteSharedMemory,
  clearSharedMemory,
} from '../services/shared-memory.service.js'
import { errorResponse, AppError } from '../utils/errors.js'
import { sanitizePromptText } from '../utils/sanitize.js'

export default async function sharedMemoryRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }

  // GET /tenants/:tenantId/shared-memory
  fastify.get('/tenants/:tenantId/shared-memory', auth, async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { category } = req.query
      const entries = await listSharedMemory(tenantId, { category })
      return reply.send({ success: true, data: entries, meta: { count: entries.length, timestamp: new Date().toISOString() } })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/shared-memory
  // Body: { key, value, category?, expiresAt? }
  fastify.post('/tenants/:tenantId/shared-memory', auth, async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { key, value, category, expiresAt } = req.body || {}
      if (!key || !value) throw new AppError('VALIDATION_ERROR', 'key and value are required', 400)
      const safeKey = sanitizePromptText(String(key)).slice(0, 500)
      const safeValue = sanitizePromptText(String(value)).slice(0, 10000)
      const entry = await upsertSharedMemory(tenantId, {
        key: safeKey, value: safeValue,
        category: category || 'GENERAL',
        agentId: null,
        source: 'HUMAN',
        expiresAt: expiresAt || null,
      })
      return reply.code(201).send({ success: true, data: entry })
    } catch (err) { return errorResponse(reply, err) }
  })

  // PUT /tenants/:tenantId/shared-memory/:id
  fastify.put('/tenants/:tenantId/shared-memory/:id', auth, async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { key, value, category, expiresAt } = req.body || {}
      if (!key || !value) throw new AppError('VALIDATION_ERROR', 'key and value are required', 400)
      const entry = await upsertSharedMemory(tenantId, {
        key: sanitizePromptText(String(key)).slice(0, 500),
        value: sanitizePromptText(String(value)).slice(0, 10000),
        category: category || 'GENERAL',
        source: 'HUMAN',
        expiresAt: expiresAt || null,
      })
      return reply.send({ success: true, data: entry })
    } catch (err) { return errorResponse(reply, err) }
  })

  // DELETE /tenants/:tenantId/shared-memory/:id
  fastify.delete('/tenants/:tenantId/shared-memory/:id', auth, async (req, reply) => {
    try {
      const { tenantId, id } = req.params
      await deleteSharedMemory(tenantId, id)
      return reply.send({ success: true })
    } catch (err) { return errorResponse(reply, err) }
  })

  // DELETE /tenants/:tenantId/shared-memory  (bulk clear)
  fastify.delete('/tenants/:tenantId/shared-memory', auth, async (req, reply) => {
    try {
      const { tenantId } = req.params
      const { category } = req.query
      const count = await clearSharedMemory(tenantId, category)
      return reply.send({ success: true, data: { deleted: count } })
    } catch (err) { return errorResponse(reply, err) }
  })
}
