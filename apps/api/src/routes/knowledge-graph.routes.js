// apps/api/src/routes/knowledge-graph.routes.js
// Named Knowledge Graph CRUD + agent linking routes + DB import
import * as graphService from '../services/knowledge-graph.service.js'
import { discoverDBSchema, importDBToGraph, getDBSources } from '../services/graph-db-importer.service.js'
import { errorResponse } from '../utils/errors.js'

function ts() { return { timestamp: new Date().toISOString() } }

export default async function knowledgeGraphRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }

  // POST /tenants/:tenantId/knowledge-graphs
  fastify.post('/tenants/:tenantId/knowledge-graphs', auth, async (req, reply) => {
    try {
      const graph = await graphService.createKnowledgeGraph({
        tenantId: req.params.tenantId, ...req.body, userId: req.user.sub
      })
      return reply.status(201).send({ success: true, data: graph, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/knowledge-graphs
  fastify.get('/tenants/:tenantId/knowledge-graphs', auth, async (req, reply) => {
    try {
      const graphs = await graphService.listKnowledgeGraphs(req.params.tenantId)
      return reply.send({ success: true, data: { knowledgeGraphs: graphs }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/knowledge-graphs/:graphId
  fastify.get('/tenants/:tenantId/knowledge-graphs/:graphId', auth, async (req, reply) => {
    try {
      const graph = await graphService.getKnowledgeGraph(req.params.tenantId, req.params.graphId)
      return reply.send({ success: true, data: graph, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // DELETE /tenants/:tenantId/knowledge-graphs/:graphId
  fastify.delete('/tenants/:tenantId/knowledge-graphs/:graphId', auth, async (req, reply) => {
    try {
      const result = await graphService.deleteKnowledgeGraph(req.params.tenantId, req.params.graphId, req.user.sub)
      return reply.send({ success: true, data: result, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/agents/:agentId/knowledge-graphs/:graphId — link
  fastify.post('/tenants/:tenantId/agents/:agentId/knowledge-graphs/:graphId', auth, async (req, reply) => {
    try {
      const result = await graphService.linkKnowledgeGraph(
        req.params.tenantId, req.params.agentId, req.params.graphId, req.user.sub
      )
      return reply.send({ success: true, data: result, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // DELETE /tenants/:tenantId/agents/:agentId/knowledge-graphs/:graphId — unlink
  fastify.delete('/tenants/:tenantId/agents/:agentId/knowledge-graphs/:graphId', auth, async (req, reply) => {
    try {
      const result = await graphService.unlinkKnowledgeGraph(
        req.params.tenantId, req.params.agentId, req.params.graphId, req.user.sub
      )
      return reply.send({ success: true, data: result, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // ── Database Import ───────────────────────────────────────────────────

  // GET /tenants/:tenantId/db-sources
  // Returns available database connections (internal + external connectors)
  fastify.get('/tenants/:tenantId/db-sources', auth, async (req, reply) => {
    try {
      const sources = await getDBSources(req.params.tenantId)
      return reply.send({ success: true, data: { sources }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/knowledge-graphs/:graphId/db-schema
  // Returns discoverable PostgreSQL tables, columns, and foreign keys
  fastify.get('/tenants/:tenantId/knowledge-graphs/:graphId/db-schema', auth, async (req, reply) => {
    try {
      const { connectionId } = req.query
      const schema = await discoverDBSchema(req.params.tenantId, connectionId || undefined)
      return reply.send({ success: true, data: schema, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/knowledge-graphs/:graphId/import-from-db
  // Imports selected PostgreSQL tables as Neo4j nodes & relationships
  fastify.post('/tenants/:tenantId/knowledge-graphs/:graphId/import-from-db', auth, async (req, reply) => {
    try {
      const { tables, limit, connectionId } = req.body || {}
      const result = await importDBToGraph(
        req.params.tenantId,
        req.params.graphId,
        { tables, limit: limit || 500, connectionId }
      )
      return reply.send({ success: true, data: result, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // ── Entity Management ──────────────────────────────────────────────────

  // POST /tenants/:tenantId/knowledge-graphs/:graphId/entities — add entity
  fastify.post('/tenants/:tenantId/knowledge-graphs/:graphId/entities', auth, async (req, reply) => {
    try {
      const entity = await graphService.addGraphEntity({
        tenantId: req.params.tenantId,
        graphId: req.params.graphId,
        label: req.body.label,
        type: req.body.type,
        userId: req.user.sub,
      })
      return reply.status(201).send({ success: true, data: entity, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/knowledge-graphs/:graphId/entities — list entities
  fastify.get('/tenants/:tenantId/knowledge-graphs/:graphId/entities', auth, async (req, reply) => {
    try {
      const entities = await graphService.listGraphEntities(req.params.tenantId, req.params.graphId)
      return reply.send({ success: true, data: { entities }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // DELETE /tenants/:tenantId/knowledge-graphs/:graphId/entities/:entityLabel — remove entity
  fastify.delete('/tenants/:tenantId/knowledge-graphs/:graphId/entities/:entityLabel', auth, async (req, reply) => {
    try {
      const result = await graphService.deleteGraphEntity(
        req.params.tenantId, req.params.graphId, req.params.entityLabel, req.user.sub
      )
      return reply.send({ success: true, data: result, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })
}
