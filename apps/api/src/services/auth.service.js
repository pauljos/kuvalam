// apps/api/src/services/auth.service.js
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'
import { query, getClient } from '../db/pool.js'
import { hashToken, generateTokens } from '../utils/jwt.js'
import { sendEmail } from '../utils/email.js'
import { auditLog } from '../utils/audit.js'
import { AppError } from '../utils/errors.js'

export async function registerUser({ email, password, name, tenantName, tenantSlug }) {
  // Validate required fields
  if (!tenantName || !tenantSlug) {
    throw new AppError('MISSING_TENANT_INFO', 'Organization name and slug are required', 400)
  }

  const normalizedEmail = email.toLowerCase()
  const normalizedSlug = tenantSlug.toLowerCase().trim()

  // Validate slug format
  if (!/^[a-z0-9-]+$/.test(normalizedSlug)) {
    throw new AppError('INVALID_SLUG', 'Organization slug must be lowercase alphanumeric with hyphens only', 400)
  }

  // Check for existing user
  const existing = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail])
  if (existing.rows.length > 0) {
    throw new AppError('EMAIL_ALREADY_EXISTS', 'An account with this email already exists', 409)
  }

  // Check for existing tenant slug
  const existingTenant = await query('SELECT id FROM tenants WHERE slug = $1', [normalizedSlug])
  if (existingTenant.rows.length > 0) {
    throw new AppError('SLUG_ALREADY_EXISTS', 'This organization slug is already taken', 409)
  }

  const passwordHash = await bcrypt.hash(password, 12)

  // Start transaction
  const client = await getClient()
  try {
    await client.query('BEGIN')

    // Create user
    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, password_hash, name, email_verified)
       VALUES ($1, $2, $3, false)
       RETURNING id, email, name, created_at`,
      [normalizedEmail, passwordHash, name]
    )

    // Create tenant with PENDING approval status
    const { rows: [tenant] } = await client.query(
      `INSERT INTO tenants (name, slug, plan, status, approval_status)
       VALUES ($1, $2, 'TRIAL', 'ACTIVE', 'PENDING')
       RETURNING id, slug, approval_status`,
      [tenantName.trim(), normalizedSlug]
    )

    // Add user as OWNER of the tenant
    await client.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'OWNER', 'ACTIVE', NOW())`,
      [tenant.id, user.id]
    )

    await client.query('COMMIT')

    // Send welcome email (non-blocking)
    sendEmail({
      to: email,
      subject: 'Welcome to Kuvalam - Awaiting Approval',
      html: `<h2>Welcome to Kuvalam, ${name}!</h2>
             <p>Your organization "${tenantName}" (${normalizedSlug}) has been created and is awaiting approval from our team.</p>
             <p>You'll receive an email once your account is approved.</p>`
    }).catch(() => {})

    await auditLog({ 
      eventType: 'user.registered', 
      actorId: user.id, 
      actorType: 'USER', 
      action: 'REGISTER',
      metadata: { tenantId: tenant.id, tenantSlug: normalizedSlug }
    })

    return { 
      userId: user.id, 
      email: user.email, 
      tenantSlug: normalizedSlug,
      approvalStatus: 'PENDING',
      message: 'Account created successfully. Awaiting approval from system administrator.' 
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function loginUser({ email, password, tenantSlug, ip }) {
  const normalizedEmail = email.toLowerCase()

  const { rows } = await query(
    `SELECT id, email, name, password_hash, email_verified, mfa_enabled, is_system_admin
     FROM users WHERE email = $1`,
    [normalizedEmail]
  )

  if (rows.length === 0) {
    throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401)
  }

  const user = rows[0]
  const validPassword = await bcrypt.compare(password, user.password_hash)
  if (!validPassword) {
    throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401)
  }

  // System admins can login without tenant slug
  if (!tenantSlug && !user.is_system_admin) {
    throw new AppError('TENANT_SLUG_REQUIRED', 'Organization slug is required to login', 400)
  }

  let tenantMembership = null

  // If tenant slug provided, verify access to that tenant
  if (tenantSlug) {
    const normalizedSlug = tenantSlug.toLowerCase().trim()
    
    const { rows: memberships } = await query(
      `SELECT tm.role, tm.status, t.id, t.name, t.slug, t.plan, t.status as tenant_status, t.approval_status
       FROM tenant_members tm
       JOIN tenants t ON t.id = tm.tenant_id
       WHERE tm.user_id = $1 AND tm.status = 'ACTIVE' AND t.slug = $2`,
      [user.id, normalizedSlug]
    )

    // System admins can access any tenant, regular users need membership
    if (memberships.length === 0 && !user.is_system_admin) {
      throw new AppError('TENANT_ACCESS_DENIED', 'You do not have access to this organization', 403)
    }

    tenantMembership = memberships[0]
  }

  // Check tenant approval status (system admins can bypass)
  if (!user.is_system_admin && tenantMembership) {
    if (tenantMembership.approval_status === 'PENDING') {
      throw new AppError('TENANT_PENDING_APPROVAL', 'Your organization is pending approval. Please wait for administrator approval.', 403)
    }
    if (tenantMembership.approval_status === 'SUSPENDED') {
      throw new AppError('TENANT_SUSPENDED', 'Your organization has been suspended. Please contact support.', 403)
    }
    if (tenantMembership.approval_status === 'REJECTED') {
      throw new AppError('TENANT_REJECTED', 'Your organization registration was rejected.', 403)
    }
    if (tenantMembership.tenant_status !== 'ACTIVE') {
      throw new AppError('TENANT_INACTIVE', 'This organization is not active', 403)
    }
  }

  // Generate tokens
  const { accessPayload, refreshToken } = generateTokens(user, tenantMembership || null)

  // Store hashed refresh token
  const tokenHash = hashToken(refreshToken)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, tokenHash, expiresAt]
  )

  // Update last login
  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id])
  await auditLog({ 
    eventType: 'user.logged_in', 
    actorId: user.id, 
    actorType: 'USER', 
    action: 'LOGIN', 
    metadata: { ip, tenantSlug: tenantSlug || null } 
  })

  return {
    accessPayload,
    refreshToken,
    user: { id: user.id, email: user.email, name: user.name, isSystemAdmin: user.is_system_admin || false },
    tenant: tenantMembership ? {
      id: tenantMembership.id,
      name: tenantMembership.name,
      slug: tenantMembership.slug,
      plan: tenantMembership.plan,
      role: tenantMembership.role
    } : null
  }
}

export async function refreshAccessToken(refreshToken) {
  const tokenHash = hashToken(refreshToken)
  const { rows } = await query(
    `SELECT rt.*, u.id as user_id, u.email, u.name, u.is_system_admin
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.revoked = false AND rt.expires_at > NOW()`,
    [tokenHash]
  )

  if (rows.length === 0) {
    throw new AppError('REFRESH_TOKEN_INVALID', 'Invalid or expired refresh token', 401)
  }

  const { rows: memberships } = await query(
    `SELECT tm.role, t.id, t.name, t.slug, t.plan
     FROM tenant_members tm JOIN tenants t ON t.id = tm.tenant_id
     WHERE tm.user_id = $1 AND tm.status = 'ACTIVE' LIMIT 1`,
    [rows[0].user_id]
  )

  const user = { id: rows[0].user_id, email: rows[0].email, name: rows[0].name, is_system_admin: rows[0].is_system_admin }
  const { accessPayload } = generateTokens(user, memberships[0] || null)

  return { accessPayload, expiresAt: new Date(Date.now() + 15 * 60 * 1000) }
}

export async function logoutUser(refreshToken) {
  if (!refreshToken) return
  const tokenHash = hashToken(refreshToken)
  await query('UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1', [tokenHash])
}
