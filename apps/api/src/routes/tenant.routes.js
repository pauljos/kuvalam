// apps/api/src/routes/tenant.routes.js
import * as tenantService from '../services/tenant.service.js'
import { errorResponse } from '../utils/errors.js'
import { cached, del as cacheDel } from '../services/cache.service.js'

export default async function tenantRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }
  const requireRole = (roles) => ({
    preHandler: [fastify.authenticate, async (req, reply) => {
      if (!roles.includes(req.user.role)) {
        return reply.status(403).send({ success: false, error: { code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action' } })
      }
    }]
  })

  // POST /tenants — create new tenant
  fastify.post('/tenants', auth, async (request, reply) => {
    try {
      const tenant = await tenantService.createTenant({ ...request.body, userId: request.user.sub })
      return reply.status(201).send({ success: true, data: tenant, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId
  fastify.get('/tenants/:tenantId', auth, async (request, reply) => {
    try {
      const tenantId = request.params.tenantId
      const tenant = await cached(
        `tenant:${tenantId}:info`,
        () => tenantService.getTenant(tenantId),
        600 // Cache for 10 minutes
      )
      return reply.send({ success: true, data: tenant, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // PATCH /tenants/:tenantId
  fastify.patch('/tenants/:tenantId', requireRole(['OWNER', 'ADMIN']), async (request, reply) => {
    try {
      const tenantId = request.params.tenantId
      const tenant = await tenantService.updateTenant(tenantId, request.body, request.user.sub)
      // Invalidate cache
      await cacheDel(`tenant:${tenantId}:info`)
      return reply.send({ success: true, data: tenant, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/members
  fastify.get('/tenants/:tenantId/members', auth, async (request, reply) => {
    try {
      const tenantId = request.params.tenantId
      const members = await cached(
        `tenant:${tenantId}:members`,
        () => tenantService.getMembers(tenantId),
        300 // Cache for 5 minutes
      )
      return reply.send({ success: true, data: { members }, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/members/invite
  fastify.post('/tenants/:tenantId/members/invite', requireRole(['OWNER', 'ADMIN']), async (request, reply) => {
    try {
      const result = await tenantService.inviteMember({
        tenantId: request.params.tenantId,
        ...request.body,
        invitedBy: request.user.sub
      })
      return reply.status(201).send({ success: true, data: result, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // PATCH /tenants/:tenantId/members/:memberId
  fastify.patch('/tenants/:tenantId/members/:memberId', requireRole(['OWNER', 'ADMIN']), async (request, reply) => {
    try {
      const result = await tenantService.updateMemberRole(request.params.tenantId, request.params.memberId, request.body.role, request.user.sub)
      return reply.send({ success: true, data: result, meta: ts() })
    } catch (err) { return errorResponse(reply, err) }
  })

  // DELETE /tenants/:tenantId/members/:memberId
  fastify.delete('/tenants/:tenantId/members/:memberId', requireRole(['OWNER', 'ADMIN']), async (request, reply) => {
    try {
      await tenantService.removeMember(request.params.tenantId, request.params.memberId, request.user.sub)
      return reply.status(204).send()
    } catch (err) { return errorResponse(reply, err) }
  })
}

const ts = () => ({ timestamp: new Date().toISOString() })
