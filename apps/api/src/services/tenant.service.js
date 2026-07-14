// apps/api/src/services/tenant.service.js
import { query, transaction } from '../db/pool.js'
import { auditLog } from '../utils/audit.js'
import { sendEmail } from '../utils/email.js'
import { randomBytes } from 'crypto'
import { AppError } from '../utils/errors.js'

const PLAN_LIMITS = {
  TRIAL:      { agents: 5,         kbs: 2,   workflows: 5,    members: 3 },
  PRO:        { agents: 25,        kbs: 20,  workflows: 50,   members: 25 },
  ENTERPRISE: { agents: Infinity,  kbs: Infinity, workflows: Infinity, members: Infinity }
}

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
  const allowed = ['name', 'settings', 'llm_config']
  const fields = Object.keys(updates).filter(k => allowed.includes(k))
  if (fields.length === 0) throw new AppError('NO_VALID_FIELDS', 'No valid fields to update', 400)

  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ')
  const values = fields.map(f => updates[f])

  const { rows } = await query(
    `UPDATE tenants SET ${setClause} WHERE id = $1 RETURNING *`,
    [tenantId, ...values]
  )

  await auditLog({ eventType: 'tenant.updated', tenantId, actorId: userId, actorType: 'USER', action: 'UPDATE_TENANT', afterState: updates })
  return rows[0]
}

export async function inviteMember({ tenantId, email, role, invitedBy }) {
  // Check plan limits
  const { rows: [countRow] } = await query(
    `SELECT COUNT(*) as count, t.plan FROM tenant_members tm
     JOIN tenants t ON t.id = tm.tenant_id
     WHERE tm.tenant_id = $1 AND tm.status IN ('ACTIVE','INVITED')
     GROUP BY t.plan`,
    [tenantId]
  )

  const plan = countRow?.plan || 'TRIAL'
  const limit = PLAN_LIMITS[plan]?.members || 3
  if (parseInt(countRow?.count || 0) >= limit) {
    throw new AppError('MEMBER_LIMIT_REACHED', `Your ${plan} plan allows max ${limit} members`, 402)
  }

  const inviteToken = randomBytes(32).toString('hex')

  // Check if user exists
  const { rows: [existingUser] } = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])

  // Check if already a member
  if (existingUser) {
    const { rows: [member] } = await query(
      'SELECT id FROM tenant_members WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, existingUser.id]
    )
    if (member) throw new AppError('ALREADY_MEMBER', 'This user is already a member', 409)

    // Add directly
    await query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, status, invited_by, invite_token)
       VALUES ($1, $2, $3, 'INVITED', $4, $5)`,
      [tenantId, existingUser.id, role, invitedBy, inviteToken]
    )
  } else {
    // Create placeholder (they'll complete signup via invite link)
    await query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, status, invited_by, invite_token)
       SELECT $1, id, $2, 'INVITED', $3, $4 FROM users WHERE email = $5
       ON CONFLICT DO NOTHING`,
      [tenantId, role, invitedBy, inviteToken, email.toLowerCase()]
    )
  }

  // Get tenant name for email
  const { rows: [tenant] } = await query('SELECT name FROM tenants WHERE id = $1', [tenantId])

  await sendEmail({
    to: email,
    subject: `You've been invited to join ${tenant.name} on Kuvalam`,
    html: `
      <h2>You've been invited to ${tenant.name}</h2>
      <p>You've been invited as a <strong>${role}</strong>.</p>
      <a href="${process.env.FRONTEND_URL}/invite?token=${inviteToken}">Accept Invitation</a>
    `
  })

  await auditLog({ eventType: 'tenant.member_invited', tenantId, actorId: invitedBy, actorType: 'USER', action: 'INVITE_MEMBER', afterState: { email, role } })

  return { email, role, status: 'INVITED' }
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
