// apps/api/src/routes/knowledge-infra.routes.js
// Knowledge Infrastructure routes — provision local vector DB / graph DB
// and auto-create connectors pointing to them.

import { getKnowledgeInfraStatus, startKnowledgeService, createInfraConnector } from '../services/knowledge-infra.service.js'
import { errorResponse, AppError } from '../utils/errors.js'

export default async function knowledgeInfraRoutes(fastify) {
  const isProduction = process.env.NODE_ENV === 'production'

  // GET /tenants/:tenantId/knowledge-infra/status
  fastify.get('/tenants/:tenantId/knowledge-infra/status', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    try {
      if (isProduction) {
        throw new AppError('NOT_AVAILABLE', 'Knowledge infra management is only available in local environments', 403)
      }
      const { tenantId } = req.params
      const status = await getKnowledgeInfraStatus(tenantId)
      return reply.send({ success: true, data: status, meta: { timestamp: new Date().toISOString() } })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/knowledge-infra/start
  // Body: { service: 'pgvector' | 'neo4j' }
  fastify.post('/tenants/:tenantId/knowledge-infra/start', {
    preHandler: [
      fastify.authenticate,
      async (req, reply) => {
        if (!['OWNER', 'ADMIN'].includes(req.user.role)) {
          return reply.status(403).send({
            success: false,
            error: { code: 'INSUFFICIENT_PERMISSIONS', message: 'Only OWNER or ADMIN can manage infrastructure' }
          })
        }
      }
    ]
  }, async (req, reply) => {
    try {
      if (isProduction) {
        throw new AppError('NOT_AVAILABLE', 'Infrastructure start is only available in local environments', 403)
      }
      const { service } = req.body || {}
      if (!service || !['pgvector', 'neo4j'].includes(service)) {
        throw new AppError('INVALID_PARAM', 'service must be "pgvector" or "neo4j"', 400)
      }
      const result = await startKnowledgeService(service)
      return reply.send({ success: true, data: result, meta: { timestamp: new Date().toISOString() } })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/knowledge-infra/create-connector
  // Body: { service: 'pgvector' | 'neo4j' }
  fastify.post('/tenants/:tenantId/knowledge-infra/create-connector', {
    preHandler: [
      fastify.authenticate,
      async (req, reply) => {
        if (!['OWNER', 'ADMIN'].includes(req.user.role)) {
          return reply.status(403).send({
            success: false,
            error: { code: 'INSUFFICIENT_PERMISSIONS', message: 'Only OWNER or ADMIN can create connectors' }
          })
        }
      }
    ]
  }, async (req, reply) => {
    try {
      if (isProduction) {
        throw new AppError('NOT_AVAILABLE', 'Connector creation is only available in local environments', 403)
      }
      const { tenantId } = req.params
      const { service } = req.body || {}
      if (!service || !['pgvector', 'neo4j'].includes(service)) {
        throw new AppError('INVALID_PARAM', 'service must be "pgvector" or "neo4j"', 400)
      }
      const result = await createInfraConnector(tenantId, req.user.id, service)
      return reply.status(201).send({
        success: true,
        data: result,
        meta: { timestamp: new Date().toISOString() }
      })
    } catch (err) { return errorResponse(reply, err) }
  })
}
