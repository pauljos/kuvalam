// apps/api/src/services/tenant.service.js
import bcrypt from 'bcryptjs'
import { query, transaction } from '../db/pool.js'
import { auditLog } from '../utils/audit.js'
import { sendEmail } from '../utils/email.js'
import { randomBytes } from 'crypto'
import { AppError } from '../utils/errors.js'
import { checkPlanLimit } from './plan-limits.service.js'

export async function createTenant({ name, slug, userId }) {
  // Validate slug format
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new AppError('INVALID_SLUG', 'Slug must be lowercase alphanumeric with hyphens only', 400)
  }

  return transaction(async (client) => {
    // Check slug uniqueness
    const { rows: existing } = await client.query('SELECT id FROM tenants WHERE slug = $1', [slug])
    if (existing.length > 0) throw new AppError('SLUG_ALREADY_TAKEN', 'This slug is already taken', 409)

    // Create tenant
    const { rows: [tenant] } = await client.query(
      `INSERT INTO tenants (name, slug, plan, status)
       VALUES ($1, $2, 'TRIAL', 'ACTIVE')
       RETURNING *`,
      [name, slug]
    )

    // Add creator as OWNER
    await client.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'OWNER', 'ACTIVE', NOW())`,
      [tenant.id, userId]
    )

    await auditLog({ eventType: 'tenant.created', tenantId: tenant.id, actorId: userId, actorType: 'USER', action: 'CREATE_TENANT', afterState: { name, slug } })

    return tenant
  })
}

export async function getTenant(tenantId) {
  const { rows } = await query(
    `SELECT t.*,
            (SELECT COUNT(*) FROM tenant_members WHERE tenant_id = t.id AND status = 'ACTIVE') as member_count,
            (SELECT COUNT(*) FROM agents WHERE tenant_id = t.id AND status != 'ARCHIVED') as agent_count
     FROM tenants t WHERE t.id = $1`,
    [tenantId]
  )
  if (rows.length === 0) throw new AppError('TENANT_NOT_FOUND', 'Tenant not found', 404)
  return rows[0]
}

export async function updateTenant(tenantId, updates, userId) {
  // Fetch current state BEFORE update for audit trail
  const { rows: [before] } = await query(
    'SELECT name FROM tenants WHERE id = $1', [tenantId]
  )
  if (!before) throw new AppError('TENANT_NOT_FOUND', 'Tenant not found', 404)

  const allowed = ['name', 'settings', 'llm_config']
  const fields = Object.keys(updates).filter(k => allowed.includes(k))
  if (fields.length === 0) throw new AppError('NO_VALID_FIELDS', 'No valid fields to update', 400)

  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ')
  const values = fields.map(f => updates[f])

  const { rows } = await query(
    `UPDATE tenants SET ${setClause} WHERE id = $1 RETURNING *`,
    [tenantId, ...values]
  )

  await auditLog({
    eventType: 'tenant.updated', tenantId, actorId: userId, actorType: 'USER',
    action: 'UPDATE_TENANT',
    beforeState: { name: before.name },
    afterState: updates
  })
  return rows[0]
}

export async function inviteMember({ tenantId, email, role, invitedBy, password }) {
  // Check plan limits
  const { rows: [countRow] } = await query(
    `SELECT COUNT(*) as count FROM tenant_members
     WHERE tenant_id = $1 AND status IN ('ACTIVE','INVITED')`,
    [tenantId]
  )
  await checkPlanLimit(tenantId, 'members', parseInt(countRow?.count || 0))

  // Check if user exists
  const { rows: [existingUser] } = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])

  // Check if already a member
  if (existingUser) {
    const { rows: [member] } = await query(
      'SELECT id FROM tenant_members WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, existingUser.id]
    )
    if (member) throw new AppError('ALREADY_MEMBER', 'This user is already a member', 409)
  }

  let userId = existingUser?.id
  let isNewUser = false

  if (!existingUser) {
    if (password) {
      // Create user with direct password (skip invite)
      const passwordHash = await bcrypt.hash(password, 12)
      const { rows: [newUser] } = await query(
        `INSERT INTO users (email, name, password_hash, email_verified)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [email.toLowerCase(), email.split('@')[0], passwordHash]
      )
      userId = newUser.id
      isNewUser = true
    } else {
      // Create user placeholder for invite flow
      const { rows: [newUser] } = await query(
        `INSERT INTO users (email, name, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [email.toLowerCase(), email.split('@')[0], 'PENDING_SETUP']
      )
      userId = newUser.id
    }
  }

  const memberStatus = password ? 'ACTIVE' : 'INVITED'
  const inviteToken = !password ? randomBytes(32).toString('hex') : null

  await query(
    `INSERT INTO tenant_members (tenant_id, user_id, role, status, invited_by, invite_token)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = EXCLUDED.status`,
    [tenantId, userId, role, memberStatus, invitedBy, inviteToken]
  )

  // Get tenant name
  const { rows: [tenant] } = await query('SELECT name FROM tenants WHERE id = $1', [tenantId])

  if (!password) {
    // Send invite email
    await sendEmail({
      to: email,
      subject: `You've been invited to join ${tenant.name} on Kuvalam`,
      html: `
        <h2>You've been invited to ${tenant.name}</h2>
        <p>You've been invited as a <strong>${role}</strong>.</p>
        <a href="${process.env.FRONTEND_URL}/invite?token=${inviteToken}">Accept Invitation</a>
      `
    })
  }

  await auditLog({
    eventType: isNewUser ? 'tenant.member_created' : 'tenant.member_invited',
    tenantId,
    actorId: invitedBy,
    actorType: 'USER',
    action: password ? 'CREATE_MEMBER' : 'INVITE_MEMBER',
    afterState: { email, role, status: memberStatus }
  })

  return { email, role, status: memberStatus }
}

export async function getMembers(tenantId) {
  const { rows } = await query(
    `SELECT tm.id, tm.role, tm.status, tm.joined_at, tm.created_at,
            u.id as user_id, u.name, u.email
     FROM tenant_members tm
     JOIN users u ON u.id = tm.user_id
     WHERE tm.tenant_id = $1 AND tm.status != 'DEACTIVATED'
     ORDER BY tm.created_at ASC`,
    [tenantId]
  )
  return rows
}

export async function updateMemberRole(tenantId, memberId, role, actorId) {
  const { rows } = await query(
    `UPDATE tenant_members SET role = $1
     WHERE id = $2 AND tenant_id = $3 AND role != 'OWNER'
     RETURNING *`,
    [role, memberId, tenantId]
  )
  if (rows.length === 0) throw new AppError('MEMBER_NOT_FOUND', 'Member not found or cannot change OWNER role', 404)
  await auditLog({ eventType: 'tenant.member_role_changed', tenantId, actorId, actorType: 'USER', action: 'UPDATE_MEMBER_ROLE', afterState: { memberId, role } })
  return rows[0]
}

export async function removeMember(tenantId, memberId, actorId) {
  const { rows } = await query(
    `UPDATE tenant_members SET status = 'DEACTIVATED'
     WHERE id = $1 AND tenant_id = $2 AND role != 'OWNER'
     RETURNING id`,
    [memberId, tenantId]
  )
  if (rows.length === 0) throw new AppError('MEMBER_NOT_FOUND', 'Member not found or cannot remove OWNER', 404)
  await auditLog({ eventType: 'tenant.member_removed', tenantId, actorId, actorType: 'USER', action: 'REMOVE_MEMBER', afterState: { memberId } })
}
