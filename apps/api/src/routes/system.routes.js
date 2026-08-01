// apps/api/src/routes/system.routes.js
// System health / dependency scan routes.
// Only available in non-production (local deployment) environments.

import { scanDependencies, installDependency, runSecurityAudit } from '../services/system-scan.service.js'
import { errorResponse, AppError } from '../utils/errors.js'

export default async function systemRoutes(fastify) {
  // Only expose these endpoints in non-production environments —
  // scanning arbitrary binaries and installing packages is not appropriate
  // on cloud-hosted production servers.
  const isProduction = process.env.NODE_ENV === 'production'

  const auth = { preHandler: [fastify.authenticate] }
  const ownerAdmin = {
    preHandler: [
      fastify.authenticate,
      async (req, reply) => {
        // System admins always have access regardless of tenant role
        if (req.user.isSystemAdmin) return
        if (!['OWNER', 'ADMIN'].includes(req.user.role)) {
          return reply.status(403).send({
            success: false,
            error: { code: 'INSUFFICIENT_PERMISSIONS', message: 'Only OWNER or ADMIN can run system scans' }
          })
        }
      }
    ]
  }

  // GET /tenants/:tenantId/system/security
  // Runs npm audit + pip check for known vulnerabilities.
  fastify.get('/tenants/:tenantId/system/security', ownerAdmin, async (req, reply) => {
    try {
      if (isProduction) {
        throw new AppError('NOT_AVAILABLE', 'Security audit is only available in local development environments', 403)
      }
      const report = await runSecurityAudit()
      return reply.send({ success: true, data: report, meta: { timestamp: new Date().toISOString() } })
    } catch (err) { return errorResponse(reply, err) }
  })

  // GET /tenants/:tenantId/system/scan
  // Scans all registered dependencies and returns their status.
  fastify.get('/tenants/:tenantId/system/scan', auth, async (req, reply) => {
    try {
      if (isProduction) {
        throw new AppError('NOT_AVAILABLE', 'System scan is only available in local development environments', 403)
      }
      const report = await scanDependencies()
      return reply.send({ success: true, data: report, meta: { timestamp: new Date().toISOString() } })
    } catch (err) { return errorResponse(reply, err) }
  })

  // POST /tenants/:tenantId/system/install
  // Attempts to install a single dependency by ID.
  // Body: { depId: 'ollama' }
  fastify.post('/tenants/:tenantId/system/install', ownerAdmin, async (req, reply) => {
    try {
      if (isProduction) {
        throw new AppError('NOT_AVAILABLE', 'Auto-install is only available in local development environments', 403)
      }

      const { depId } = req.body || {}
      if (!depId || typeof depId !== 'string') {
        throw new AppError('MISSING_PARAM', 'depId (dependency identifier) is required', 400)
      }

      const result = await installDependency(depId)
      return reply.send({
        success: result.success,
        data: {
          depId: result.depId,
          alreadyInstalled: result.alreadyInstalled || false,
          output: result.output,
          installUrl: result.installUrl || null
        },
        meta: { timestamp: new Date().toISOString() }
      })
    } catch (err) { return errorResponse(reply, err) }
  })
}
