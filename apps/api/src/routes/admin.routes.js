// apps/api/src/routes/admin.routes.js
// System admin routes for tenant management
import bcrypt from 'bcryptjs'
import { query } from '../db/pool.js'
import { errorResponse, AppError } from '../utils/errors.js'
import { auditLog } from '../utils/audit.js'
import { sendEmail } from '../utils/email.js'
import { del as cacheDel } from '../services/cache.service.js'

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

  // POST /api/v1/admin/tenants - Create a new tenant (system admin only)
  fastify.post('/admin/tenants', {
    preHandler: [fastify.authenticate, requireSystemAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'slug', 'ownerEmail', 'ownerName'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          slug: { type: 'string', pattern: '^[a-z0-9-]+$', minLength: 1, maxLength: 100 },
          ownerEmail: { type: 'string', format: 'email' },
          ownerName: { type: 'string', minLength: 1, maxLength: 255 },
          plan: { type: 'string', enum: ['FREE', 'PRO', 'ENTERPRISE'], default: 'FREE' },
          password: { type: 'string', minLength: 8, maxLength: 128 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { name, slug, ownerEmail, ownerName, plan, password } = request.body

      // Check if slug is already taken
      const { rows: existing } = await query(
        'SELECT id FROM tenants WHERE slug = $1',
        [slug]
      )
      if (existing.length > 0) {
        throw new AppError('SLUG_TAKEN', 'This slug is already in use', 409)
      }

      // Check if owner email already exists
      const { rows: existingUsers } = await query(
        'SELECT id FROM users WHERE email = $1',
        [ownerEmail]
      )

      let ownerId
      if (existingUsers.length > 0) {
        // User already exists, use their ID
        ownerId = existingUsers[0].id
      } else {
        // Hash password if provided, otherwise flag for invite/setup
        const passwordHash = password
          ? await bcrypt.hash(password, 12)
          : 'PENDING_SETUP'

        // Create new user for the owner
        const { rows: newUser } = await query(
          `INSERT INTO users (email, name, password_hash, email_verified)
           VALUES ($1, $2, $3, ${password ? 'true' : 'false'})
           RETURNING id`,
          [ownerEmail, ownerName, passwordHash]
        )
        ownerId = newUser[0].id

        if (!password) {
          // TODO: Send welcome email with password setup link
          // await sendEmail(ownerEmail, 'welcome', { name: ownerName, orgName: name })
        }
      }

      // Create the tenant
      const { rows: [tenant] } = await query(
        `INSERT INTO tenants (name, slug, plan, approval_status, status)
         VALUES ($1, $2, $3, 'APPROVED', 'ACTIVE')
         RETURNING *`,
        [name, slug, plan || 'FREE']
      )

      // Add owner as tenant member with OWNER role
      await query(
        `INSERT INTO tenant_members (tenant_id, user_id, role, status)
         VALUES ($1, $2, 'OWNER', 'ACTIVE')`,
        [tenant.id, ownerId]
      )

      await auditLog({
        eventType: 'admin.tenant_created',
        actorId: request.user.sub,
        actorType: 'USER',
        resourceType: 'Tenant',
        resourceId: tenant.id,
        action: 'CREATE_TENANT',
        afterState: { name, slug, ownerEmail, plan }
      })

      return reply.status(201).send({
        success: true,
        data: { tenant, owner: { id: ownerId, email: ownerEmail, name: ownerName } },
        meta: { requestId: request.id, timestamp: new Date().toISOString() }
      })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // PATCH /api/v1/admin/tenants/:tenantId/plan - Update tenant plan
  fastify.patch('/admin/tenants/:tenantId/plan', {
    preHandler: [fastify.authenticate, requireSystemAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['plan'],
        properties: {
          plan: { type: 'string', enum: ['TRIAL', 'FREE', 'PRO', 'ENTERPRISE'] }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { tenantId } = request.params
      const { plan } = request.body

      const { rows: [tenant] } = await query(
        `UPDATE tenants SET plan = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [plan, tenantId]
      )

      if (!tenant) {
        throw new AppError('TENANT_NOT_FOUND', 'Organization not found', 404)
      }

      // Invalidate cached settings so the frontend sees the change immediately
      await cacheDel(`tenant:${tenantId}:settings`)
      await cacheDel(`tenant:${tenantId}:info`)

      await auditLog({
        eventType: 'admin.tenant_plan_updated',
        actorId: request.user.sub,
        actorType: 'USER',
        resourceType: 'Tenant',
        resourceId: tenantId,
        action: 'UPDATE_PLAN',
        afterState: { plan }
      })

      return reply.send({
        success: true,
        data: tenant,
        meta: { requestId: request.id, timestamp: new Date().toISOString() }
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
        }).catch(err => console.error('[Admin] Failed to send approval email:', err.message))
      }

      // Invalidate tenant caches so status change reflects immediately
      await cacheDel(`tenant:${tenantId}:settings`)
      await cacheDel(`tenant:${tenantId}:info`)

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
        }).catch(err => console.error('[Admin] Failed to send suspension email:', err.message))
      }

      // Invalidate tenant caches
      await cacheDel(`tenant:${tenantId}:settings`)
      await cacheDel(`tenant:${tenantId}:info`)

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
        }).catch(err => console.error('[Admin] Failed to send rejection email:', err.message))
      }

      // Invalidate tenant caches
      await cacheDel(`tenant:${tenantId}:settings`)
      await cacheDel(`tenant:${tenantId}:info`)

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

      // Invalidate tenant caches so status change reflects immediately
      await cacheDel(`tenant:${tenantId}:settings`)
      await cacheDel(`tenant:${tenantId}:info`)

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

  // ── Platform Settings (sysadmin only) ────────────────────────────────────
  // These are feature flags that affect the entire platform.
  // Each setting defaults to a safe/disabled value and must be explicitly
  // enabled by a sysadmin. This lets you wire up future features without
  // enforcing them until ready.
  //
  // Known settings:
  //   email_verification_required  ('true'|'false', default 'false')
  //     When 'true': users must have email_verified=true to log in.
  //     When 'false': login succeeds but the response includes a
  //     requiresEmailVerification warning flag for the frontend banner.

  // GET /admin/platform-settings — list all platform settings
  fastify.get('/admin/platform-settings', {
    preHandler: [fastify.authenticate, requireSystemAdmin]
  }, async (request, reply) => {
    try {
      const { listPlatformSettings } = await import('../services/platform-settings.service.js')
      const settings = await listPlatformSettings()
      return reply.send({ success: true, data: { settings } })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })

  // PATCH /admin/platform-settings/:key — update a specific setting
  // Body: { value: string }
  fastify.patch('/admin/platform-settings/:key', {
    preHandler: [fastify.authenticate, requireSystemAdmin]
  }, async (request, reply) => {
    try {
      const { key } = request.params
      const { value } = request.body || {}

      // Whitelist of known, writable setting keys
      const WRITABLE_KEYS = new Set([
        'email_verification_required',
      ])

      if (!WRITABLE_KEYS.has(key)) {
        return reply.code(400).send({
          error: { code: 'UNKNOWN_SETTING', message: `Unknown platform setting key: '${key}'. Allowed: ${[...WRITABLE_KEYS].join(', ')}` }
        })
      }

      if (value === undefined || value === null) {
        return reply.code(400).send({ error: { code: 'MISSING_VALUE', message: 'value is required' } })
      }

      // Type-coerce booleans so the UI can send true/false or 'true'/'false'
      const normalizedValue = (value === true || value === 'true') ? 'true' : 'false'

      const { setEmailVerificationRequired } = await import('../services/platform-settings.service.js')
      if (key === 'email_verification_required') {
        await setEmailVerificationRequired(normalizedValue === 'true')
      }

      await auditLog({
        eventType: 'platform.setting_changed',
        actorId: request.user.sub,
        actorType: 'USER',
        action: 'UPDATE_PLATFORM_SETTING',
        metadata: { key, value: normalizedValue }
      })

      return reply.send({
        success: true,
        data: { key, value: normalizedValue, message: `Platform setting '${key}' updated to '${normalizedValue}'` }
      })
    } catch (err) {
      return errorResponse(reply, err)
    }
  })
}

