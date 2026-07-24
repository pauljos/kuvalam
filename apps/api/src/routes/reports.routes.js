import { listReports, deleteReport } from '../services/reports.service.js'
import { errorResponse } from '../utils/errors.js'

export default async function reportsRoutes(fastify) {
  const auth = { preHandler: [fastify.authenticate] }

  // GET /api/v1/tenants/:tenantId/reports
  fastify.get('/tenants/:tenantId/reports', auth, async (request, reply) => {
    try {
      const reports = await listReports(request.params.tenantId)
      return reply.send({ success: true, data: reports })
    } catch (err) {
      const { status, payload } = errorResponse(err)
      return reply.status(status).send(payload)
    }
  })

  // DELETE /api/v1/tenants/:tenantId/reports/:reportId
  fastify.delete('/tenants/:tenantId/reports/:reportId', auth, async (request, reply) => {
    try {
      await deleteReport(request.params.tenantId, request.params.reportId)
      return reply.send({ success: true })
    } catch (err) {
      const { status, payload } = errorResponse(err)
      return reply.status(status).send(payload)
    }
  })
}
