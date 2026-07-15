// apps/api/src/routes/admin.routes.js
// System admin routes for tenant management
import { query } from '../db/pool.js'
import { errorResponse, AppError } from '../utils/errors.js'
import { auditLog } from '../utils/audit.js'
import { sendEmail } from '../utils/email.js'

// Middleware to check system admin access
async function requireSystemAdmin(request, reply) {
  if (!request.user?.isSystemAdmin) {
    throw new AppError('FORBIDDEN', 'System administrator access required', 403)
  }
}

export default async function adminRoutes(fastify) {
  // GET /api/v1/admin/tenants - List all tenants with filtering
  fastify.get('/admin/tenants', {
    preHandler: [fastify.authenticate, requireSystemAdmin],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED'] },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { status, page = 1, limit = 20 } = request.query
      const offset = (page - 1) * limit

      let whereClause = ''
      const params = []
      
      if (status) {
        whereClause = 'WHERE t.approval_status = $1'
        params.push(status)
      }

      const { rows } = await query(
        `SELECT 
          t.id, t.name, t.slug, t.plan, t.status, t.approval_status,
          t.created_at, t.approved_at, t.approved_by, t.rejection_reason,
          u.email as owner_email, u.name as owner_name,
          approver.email as approved_by_email
         FROM tenants t
         LEFT JOIN tenant_members tm ON tm.tenant_id = t.id AND tm.role = 'OWNER'
         LEFT JOIN users u ON u.id = tm.user_id
         LEFT JOIN users approver ON approver.id = t.approved_by
         ${whereClause}
         ORDER BY t.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      )

      const { rows: [{ count }] } = await query(
        `SELECT COUNT(*) FROM tenants t ${whereClause}`,
        params
      )

      return reply.send({
        success: true,
        data: {
          tenants: rows,
          pagination: {
            page,
            limit,
            total: parseInt(count),
            totalPages: Math.ceil(count / limit)
          }
        }
      })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // POST /api/v1/admin/tenants/:tenantId/approve - Approve a tenant
  fastify.post('/admin/tenants/:tenantId/approve', {
    preHandler: [fastify.authenticate, requireSystemAdmin]
  }, async (request, reply) => {
    try {
      const { tenantId } = request.params

      const { rows } = await query(
        `UPDATE tenants 
         SET approval_status = 'APPROVED', 
             approved_by = $1, 
             approved_at = NOW(),
             rejection_reason = NULL
         WHERE id = $2
         RETURNING id, name, slug, approval_status`,
        [request.user.sub, tenantId]
      )

      if (rows.length === 0) {
        throw new AppError('TENANT_NOT_FOUND', 'Tenant not found', 404)
      }

      const tenant = rows[0]

      // Get owner email to send notification
      const { rows: owners } = await query(
        `SELECT u.email, u.name 
         FROM users u
         JOIN tenant_members tm ON tm.user_id = u.id
         WHERE tm.tenant_id = $1 AND tm.role = 'OWNER'`,
        [tenantId]
      )

      // Send approval email
      if (owners.length > 0) {
        const owner = owners[0]
        sendEmail({
          to: owner.email,
          subject: 'Your Kuvalam Organization Has Been Approved!',
          html: `<h2>Great news, ${owner.name}!</h2>
                 <p>Your organization "<strong>${tenant.name}</strong>" has been approved and is now active.</p>
                 <p>You can now sign in at your Kuvalam instance using:</p>
                 <ul>
                   <li>Email: ${owner.email}</li>
                   <li>Organization: ${tenant.slug}</li>
                 </ul>
                 <p>Welcome to Kuvalam!</p>`
        }).catch(() => {})
      }

      await auditLog({
        eventType: 'tenant.approved',
        actorId: request.user.sub,
        actorType: 'USER',
        action: 'APPROVE',
        resourceType: 'TENANT',
        resourceId: tenantId,
        metadata: { tenantSlug: tenant.slug }
      })

      return reply.send({
        success: true,
        data: { tenant, message: 'Tenant approved successfully' }
      })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // POST /api/v1/admin/tenants/:tenantId/suspend - Suspend a tenant
  fastify.post('/admin/tenants/:tenantId/suspend', {
    preHandler: [fastify.authenticate, requireSystemAdmin],
    schema: {
      body: {
        type: 'object',
        properties: {
          reason: { type: 'string', maxLength: 1000 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { tenantId } = request.params
      const { reason } = request.body

      const { rows } = await query(
        `UPDATE tenants 
         SET approval_status = 'SUSPENDED',
             rejection_reason = $1,
             status = 'SUSPENDED'
         WHERE id = $2
         RETURNING id, name, slug, approval_status`,
        [reason || null, tenantId]
      )

      if (rows.length === 0) {
        throw new AppError('TENANT_NOT_FOUND', 'Tenant not found', 404)
      }

      const tenant = rows[0]

      // Get owner email to send notification
      const { rows: owners } = await query(
        `SELECT u.email, u.name 
         FROM users u
         JOIN tenant_members tm ON tm.user_id = u.id
         WHERE tm.tenant_id = $1 AND tm.role = 'OWNER'`,
        [tenantId]
      )

      // Send suspension email
      if (owners.length > 0) {
        const owner = owners[0]
        sendEmail({
          to: owner.email,
          subject: 'Your Kuvalam Organization Has Been Suspended',
          html: `<h2>Important Notice</h2>
                 <p>Your organization "<strong>${tenant.name}</strong>" has been suspended.</p>
                 ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
                 <p>Please contact support for more information.</p>`
        }).catch(() => {})
      }

      await auditLog({
        eventType: 'tenant.suspended',
        actorId: request.user.sub,
        actorType: 'USER',
        action: 'SUSPEND',
        resourceType: 'TENANT',
        resourceId: tenantId,
        metadata: { tenantSlug: tenant.slug, reason }
      })

      return reply.send({
        success: true,
        data: { tenant, message: 'Tenant suspended successfully' }
      })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // POST /api/v1/admin/tenants/:tenantId/reject - Reject a pending tenant
  fastify.post('/admin/tenants/:tenantId/reject', {
    preHandler: [fastify.authenticate, requireSystemAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['reason'],
        properties: {
          reason: { type: 'string', minLength: 1, maxLength: 1000 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { tenantId } = request.params
      const { reason } = request.body

      const { rows } = await query(
        `UPDATE tenants 
         SET approval_status = 'REJECTED',
             rejection_reason = $1
         WHERE id = $2
         RETURNING id, name, slug, approval_status`,
        [reason, tenantId]
      )

      if (rows.length === 0) {
        throw new AppError('TENANT_NOT_FOUND', 'Tenant not found', 404)
      }

      const tenant = rows[0]

      // Get owner email to send notification
      const { rows: owners } = await query(
        `SELECT u.email, u.name 
         FROM users u
         JOIN tenant_members tm ON tm.user_id = u.id
         WHERE tm.tenant_id = $1 AND tm.role = 'OWNER'`,
        [tenantId]
      )

      // Send rejection email
      if (owners.length > 0) {
        const owner = owners[0]
        sendEmail({
          to: owner.email,
          subject: 'Your Kuvalam Organization Registration',
          html: `<h2>Registration Update</h2>
                 <p>Thank you for your interest in Kuvalam.</p>
                 <p>Unfortunately, we are unable to approve your organization "${tenant.name}" at this time.</p>
                 <p><strong>Reason:</strong> ${reason}</p>
                 <p>If you have questions, please contact support.</p>`
        }).catch(() => {})
      }

      await auditLog({
        eventType: 'tenant.rejected',
        actorId: request.user.sub,
        actorType: 'USER',
        action: 'REJECT',
        resourceType: 'TENANT',
        resourceId: tenantId,
        metadata: { tenantSlug: tenant.slug, reason }
      })

      return reply.send({
        success: true,
        data: { tenant, message: 'Tenant rejected' }
      })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // POST /api/v1/admin/tenants/:tenantId/reactivate - Reactivate a suspended tenant
  fastify.post('/admin/tenants/:tenantId/reactivate', {
    preHandler: [fastify.authenticate, requireSystemAdmin]
  }, async (request, reply) => {
    try {
      const { tenantId } = request.params

      const { rows } = await query(
        `UPDATE tenants 
         SET approval_status = 'APPROVED',
             status = 'ACTIVE',
             rejection_reason = NULL
         WHERE id = $1
         RETURNING id, name, slug, approval_status`,
        [tenantId]
      )

      if (rows.length === 0) {
        throw new AppError('TENANT_NOT_FOUND', 'Tenant not found', 404)
      }

      await auditLog({
        eventType: 'tenant.reactivated',
        actorId: request.user.sub,
        actorType: 'USER',
        action: 'REACTIVATE',
        resourceType: 'TENANT',
        resourceId: tenantId
      })

      return reply.send({
        success: true,
        data: { tenant: rows[0], message: 'Tenant reactivated successfully' }
      })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })
}
